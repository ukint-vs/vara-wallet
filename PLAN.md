# Issue #20 — `--args-file <path>` + `--dry-run` for `call`, `encode`, `program upload`, `program deploy`

## Goal

Eliminate shell-escape failures for nested-JSON `--args` (e.g. 64-byte `vec u8` signature arrays) by accepting a JSON args file. Add `--dry-run` to mutating commands so agents can preview encoded SCALE payloads without signing or submitting.

## Background

Live test on 2026-04-23 shows that bash mangles a `SignedBetQuote` struct (with a 64-byte `vec u8` signature) on `--args "$VAR"` interpolation. Result reaches the wallet as broken JSON and surfaces as `{"error":"[object Object]","code":"UNKNOWN_ERROR"}`. Workaround `--args "$(cat file)"` works but is fragile.

This patch:
1. Adds `--args-file <path>` (with `-` for stdin) on `call`, `encode`, `program upload`, `program deploy`.
2. Adds `--dry-run` on `call`, `program upload`, `program deploy` — encode payload and exit (no `signAndSend`, no `queryBuilder.call()`).

## Scope expansion (autoplan)

Original plan only patched `call.ts` and `encode.ts`. Autoplan-CEO flagged that `program upload`/`deploy` parse `--args` JSON identically (`src/commands/program.ts:59`) and suffer the same shell-escape bug for Sails constructors with complex init types. By P1 (completeness) + P2 (boil lakes), expand to those subcommands too. Same shape, same helper, ~1 hour CC additional effort.

## File-by-file changes

### NEW: `src/utils/args-source.ts`

Single helper used by `call.ts`, `encode.ts`, `program.ts`. One exported function:

```ts
export interface ArgsSourceOptions {
  args?: string;          // raw --args JSON string (undefined when user did NOT pass --args)
  argsFile?: string;      // --args-file value, or '-' for stdin
  argsDefault?: string;   // default when neither is supplied (call uses '[]')
}

/**
 * Resolve effective args JSON source per mutual-exclusion + stdin rules,
 * then JSON.parse it.
 *
 * - --args + --args-file together → CliError(INVALID_ARGS_SOURCE)
 * - --args-file '-' → reads process.stdin to EOF (sync via fs.readFileSync(0))
 *   - Rejects when process.stdin.isTTY === true (no pipe attached)
 * - File-size cap of 10 MB (defensive — args files are normally tiny)
 * - On parse failure: CliError(INVALID_ARGS) with parse-position info,
 *   never echoing the file path (privacy: file may contain seeds)
 *
 * Returns the parsed value (caller decides whether to wrap non-arrays).
 */
export function loadArgsJson(opts: ArgsSourceOptions): unknown;
```

Implementation:

- **Mutual exclusion:** when both `args` (defined and not the default sentinel) and `argsFile` are set → throw:
  `CliError("Cannot use --args and --args-file together; pick one. (--args for inline JSON, --args-file for file path or - for stdin)", 'INVALID_ARGS_SOURCE')`
  - Detection: helper accepts the *raw* user-provided value. We drop the commander `'[]'` default on `--args` so `undefined` means "not user-supplied". Helper substitutes `argsDefault` only when both are absent. Backward-compat: `'[]'` still applies for `call`.

- **Stdin (`-`):**
  - First check `process.stdin.isTTY`. If true → `CliError("--args-file '-' requires JSON piped on stdin (got an interactive terminal). Pipe the JSON: 'cat args.json | vara-wallet ...'", 'STDIN_IS_TTY')`.
  - Read via `fs.readFileSync(0, 'utf-8')` (POSIX FD 0).
  - Empty input → `CliError("--args-file '-' received empty input on stdin.", 'INVALID_ARGS')`.

- **File read:**
  - `fs.statSync(path)` — if size > 10_485_760 bytes → `CliError("Args file too large (max 10 MB).", 'ARGS_FILE_TOO_LARGE')`.
  - `fs.readFileSync(path, 'utf-8')`.
  - Read errors (ENOENT, EACCES, EISDIR): wrap as `CliError("Failed to read args file: " + sysErrorMsg, 'ARGS_FILE_READ_ERROR')`. The system message includes the path — fine. The existing `sanitizeErrorMessage` will scrub any hex blobs in path strings (e.g. `/tmp/0xABCD.../args.json`).

- **JSON.parse failures (CRITICAL — privacy):**
  - Catch `SyntaxError`. Extract position from message via regex `/at position (\d+)/`.
  - Build a NEW error message that includes ONLY: line/column/position info + the truncated parser snippet. NEVER include the file path or the file content beyond the snippet.
  - `CliError("Failed to parse args JSON at position " + pos + ": " + parserHint, 'INVALID_ARGS')`.
  - When position extraction fails, fall back to `'Failed to parse args JSON: ' + sanitizedSyntaxErrorMessage`. The SyntaxError.message from native `JSON.parse` does NOT include the input string or the file path — verified across Node 20-24. So the fallback is safe.

### MODIFY: `src/commands/call.ts`

1. Add options:
   - `.option('--args-file <path>', 'read --args JSON from file (use - for stdin)')`
   - `.option('--dry-run', 'encode the payload and exit without signing or submitting (no account required)')`
2. Drop the `'[]'` default on `--args` so absence is detectable.
3. Replace inline JSON.parse block (lines 58-67) with `loadArgsJson({ args: options.args, argsFile: options.argsFile, argsDefault: '[]' })`.
4. Mutual exclusion: `--estimate` + `--dry-run` together → `CliError("Cannot use --estimate and --dry-run together; pick one.", 'CONFLICTING_OPTIONS')`.
5. Pass `dryRun` into `executeQuery`/`executeFunction` via the options bag.
6. Dry-run branch in `executeQuery` (after `coerceArgsAuto`):
   - Use `query.encodePayload(...args)` to get the encoded hex.
   - Emit:
     ```json
     {"kind": "query", "service": "Svc", "method": "Mtd", "args": [...coerced...], "encodedPayload": "0x...", "willSubmit": false}
     ```
   - Return — do NOT call `queryBuilder.call()`.
7. Dry-run branch in `executeFunction` (BEFORE `resolveAccount`):
   - Build `txBuilder = func(...args)` directly.
   - Read `txBuilder.payload` (verified `node_modules/sails-js/lib/transaction-builder.d.ts:52`).
   - Emit:
     ```json
     {"kind": "function", "service": "Svc", "method": "Mtd", "args": [...coerced...], "encodedPayload": "0x...",
      "value": "0", "gasLimit": null, "voucherId": null, "willSubmit": false}
     ```
     Include `value`, `gasLimit`, `voucherId` only when user passed them (otherwise `null` / omitted) for round-trip diagnostics.
   - Return — no account resolution, no `calculateGas`, no `signAndSend`.
   - Dry-run on functions does NOT require an account (key DX win — agents can dry-run on machines with no wallet).

### MODIFY: `src/commands/encode.ts`

1. Add `.option('--args-file <path>', 'read JSON value from file (use - for stdin)')` on the `encode` subcommand only (not `decode` — no args concept).
2. Mutual exclusion: positional `<value>` + `--args-file` together → `INVALID_ARGS_SOURCE`. Easiest: change positional from `<value>` to `[value]` (optional), then validate one or the other is present.
3. Routing:
   - If `--args-file` is set → use `loadArgsJson({ argsFile, argsDefault: undefined })`. Strict JSON, no string fallback.
   - Else if positional `value` is set → keep existing `try { JSON.parse } catch { use raw string }` behavior (backward compat — `encode text "hello"` works without quoting).
   - Else → `CliError("Provide a value (positional) or --args-file <path>", 'MISSING_ENCODING_INPUT')`.

### MODIFY: `src/commands/program.ts`

Apply the same patch shape to `upload` and `deploy` subcommands and to `resolveInitPayload`:

1. Both subcommands: add `.option('--args-file <path>', 'read constructor --args JSON from file (use - for stdin)')` and `.option('--dry-run', 'encode the constructor payload and exit without uploading')`.
2. Extend `InitOptions` interface with `argsFile?: string`. Update `resolveInitPayload` to use `loadArgsJson` when `argsFile` is set:
   ```ts
   if (options.args || options.argsFile) {
     const parsed = loadArgsJson({ args: options.args, argsFile: options.argsFile });
     args = Array.isArray(parsed) ? parsed : [parsed];
   }
   ```
3. Drop the inline JSON.parse block (lines 56-64).
4. Dry-run branch: in both `upload.action` and `deploy.action`, AFTER `resolveInitPayload(options)` returns the encoded hex, if `options.dryRun` is true:
   - Emit:
     ```json
     {"kind": "program-upload" | "program-deploy", "init": "<ctorName-or-null>",
      "initPayload": "0x...", "value": "...", "gasLimit": null, "willSubmit": false}
     ```
   - Skip account resolution, gas calculation, and `executeTx`. Return immediately.
   - Account resolution must move to AFTER the dry-run check (currently it's first). For `upload`, `wasmPath` existence check must still run (it's a precondition for resolving init payload via `--idl`). Account resolution itself moves below.

### Tests — NEW FILE: `src/__tests__/args-source.test.ts`

Unit tests for `loadArgsJson`:
- Returns parsed array from inline `args`.
- Returns parsed array from file path.
- `'-'` triggers stdin read (mock `fs.readFileSync` with FD `0`, also mock `process.stdin.isTTY = false`).
- `'-'` with isTTY = true → throws `STDIN_IS_TTY`.
- Both `args` and `argsFile` set → throws `INVALID_ARGS_SOURCE`.
- Malformed JSON in file → throws `INVALID_ARGS`. **Asserts error message does NOT contain the file path.**
- Missing file → throws `ARGS_FILE_READ_ERROR`.
- File > 10 MB → throws `ARGS_FILE_TOO_LARGE` (mock `fs.statSync` to return `{ size: 11000000 }`).
- Empty stdin with `'-'` → throws.
- Default behavior: neither set, `argsDefault: '[]'` → returns `[]`.

### Tests — NEW FILE: `src/__tests__/args-file-encode.test.ts`

Round-trip integration test: 64-byte `vec u8` parity.
- Build sails program from `sample-v2.idl` (`Demo/Echo` takes `data: [u8], hash: [u8; 32]`).
- Construct args twice — once via inline `loadArgsJson({ args: '[hex64bytes, hex32bytes]' })`, once via `loadArgsJson({ argsFile: tmpPath })`.
- Run both through `coerceArgsAuto` and `func.encodePayload(...args)`.
- Assert: byte-identical encoded hex.

### Tests — NEW FILE: `src/__tests__/dry-run.test.ts`

Extract a small pure helper from each command's dry-run branch (`buildCallDryRun`, `buildProgramDryRun`) and unit-test:
- `buildCallDryRun({ kind: 'function', ... })` returns expected shape.
- `buildCallDryRun({ kind: 'query', ... })` returns expected shape.
- `--estimate` + `--dry-run` exclusion: helper or command-level test that the option-validator throws `CONFLICTING_OPTIONS`.
- Mock `txBuilder` with a `signAndSend` jest.fn — assert NOT called when `dryRun: true`.
- Mock `queryBuilder` with a `call` jest.fn — assert NOT called when `dryRun: true`.

## Error shapes (exact)

```jsonc
// Mutual exclusion
{"error": "Cannot use --args and --args-file together; pick one. (--args for inline JSON, --args-file for file path or - for stdin)", "code": "INVALID_ARGS_SOURCE"}

// Estimate + dry-run conflict
{"error": "Cannot use --estimate and --dry-run together; pick one.", "code": "CONFLICTING_OPTIONS"}

// Malformed JSON (NO PATH, NO CONTENT BEYOND SNIPPET)
{"error": "Failed to parse args JSON at position 22: Unexpected token } in JSON", "code": "INVALID_ARGS"}

// Missing file (path is OK — system error, no file content leaks)
{"error": "Failed to read args file: ENOENT: no such file or directory, open '/tmp/missing.json'", "code": "ARGS_FILE_READ_ERROR"}

// File too large
{"error": "Args file too large (max 10 MB).", "code": "ARGS_FILE_TOO_LARGE"}

// Stdin requested but TTY attached
{"error": "--args-file '-' requires JSON piped on stdin (got an interactive terminal). Pipe the JSON: 'cat args.json | vara-wallet ...'", "code": "STDIN_IS_TTY"}

// Dry-run output (call, function)
{"kind": "function", "service": "Counter", "method": "Increment", "args": [...], "encodedPayload": "0x...", "value": "0", "gasLimit": null, "voucherId": null, "willSubmit": false}

// Dry-run output (call, query)
{"kind": "query", "service": "Counter", "method": "Get", "args": [], "encodedPayload": "0x...", "willSubmit": false}

// Dry-run output (program upload)
{"kind": "program-upload", "init": "New", "initPayload": "0x...", "value": "0", "gasLimit": null, "willSubmit": false}
```

## Test count expectation

Project sits at 397 tests on main (per task brief — the actual current count may differ, will measure pre-change).
Adding ~15-18 new tests across three new test files. Final ~412-415 green.

## CLI ergonomics

```bash
# inline (existing — unchanged)
vara-wallet call $PID Counter/Increment --args '[1,2,3]'

# file
vara-wallet call $PID Counter/Increment --args-file ./args.json

# stdin
echo '[1,2,3]' | vara-wallet call $PID Counter/Increment --args-file -

# dry-run preview (call function)
vara-wallet call $PID Counter/Increment --args-file ./args.json --idl ./idl --dry-run

# dry-run preview (program upload)
vara-wallet program upload ./prog.wasm --idl ./idl --init New --args-file ./ctor.json --dry-run

# encode
vara-wallet encode T --args-file ./val.json --idl ./idl --method Svc/Mtd
```

## Backward compatibility

- Existing `--args '[]'` callers: unchanged — helper defaults to `[]` when neither flag set.
- Existing `encode <type> <value>` positional: unchanged when `--args-file` not used.
- Existing `program upload --args` callers: unchanged.
- No new required flags. No changes to JSON output shape on success paths.
- `--dry-run` is opt-in; default behavior preserved.

## Out of scope

- YAML/TOML args files. JSON only (P4: would duplicate functionality, add deps).
- `--args-file` for `encode decode` (no args concept on decode).
- Streaming validation (file is read whole — args are small).
- README documentation updates (defer to TODOS — small follow-up).

## Risks

- **Commander handling of optional positional `[value]` in `encode`:** switching from `<value>` to `[value]` might break edge cases. Mitigated by the explicit "missing input" check that fires when neither positional nor `--args-file` is provided.
- **Dropping `'[]'` default on `call --args` for mutual-exclusion detection:** must ensure no other code path expects the default. Verified: only the action handler reads it.
- **Stdin reads in test environment:** tests must mock `fs.readFileSync(0, ...)` and `process.stdin.isTTY` carefully — Jest's stdin is non-TTY, raw read could hang in CI.
- **Dry-run output stability:** keys must be in fixed order in the object literal so JSON.stringify produces deterministic output for diff-friendly agent workflows. (V8 preserves insertion order for string keys — relied on widely.)
- **`program.ts` dry-run reorder:** must move account resolution AFTER the dry-run check in both `upload` and `deploy`. Verify via test that `--dry-run` works without an account configured.

## Sequencing

1. Write helper + helper tests.
2. Wire `call.ts` (with dry-run + estimate-conflict).
3. Wire `encode.ts`.
4. Wire `program.ts` (`resolveInitPayload` + both subcommands' dry-run branches).
5. Run `npx tsc --noEmit` → fix.
6. Run `npm test` → fix.
7. Commit on `feat/args-file-dry-run` (no `--no-verify`, no `--amend`).
8. Invoke `/review` (skill name: `review`). Apply fixes.
9. Invoke `/ship` (skill name: `ship`). Branch push + PR creation handled by `/ship`.

## Decision Audit Trail

| # | Phase | Decision | Class | Principle | Rationale | Rejected |
|---|-------|----------|-------|-----------|-----------|----------|
| 1 | CEO | Reject "auto-detect path" magic in `--args` | mech | P5 | Explicit > clever; agents prefer predictability | magic detection |
| 2 | CEO | Reject YAML/TOML support | mech | P4 | Adds dep, JSON sufficient | yaml lib |
| 3 | CEO | EXPAND to `program upload`/`deploy` | mech | P1+P2 | Same bug, same fix, in blast radius, <1d CC | original tight scope |
| 4 | CEO | EXPAND `--dry-run` to program upload/deploy | mech | P1+P2 | Agents pay gas to deploy — preview is high-value | function-only dry-run |
| 5 | Eng | Add `--estimate` + `--dry-run` mutual exclusion | mech | P5 | Two preview modes, picking one is unambiguous | silent override |
| 6 | Eng | Add isTTY check for `--args-file -` | mech | P3 | Prevents agent hangs in interactive shell — common AI pitfall | hang and let user ctrl-C |
| 7 | Eng | Add 10 MB file-size cap | mech | P3 | Defensive, args files are tiny in practice | unbounded read |
| 8 | DX | Help text mentions `-` for stdin in `--args-file` description | mech | P5 | Discoverability via `--help` is the primary onboarding | terse description |
| 9 | DX | Mutual-exclusion error includes guidance on which flag does what | mech | P3 | Reduces second-error follow-up | bare error |
| 10 | DX | Dry-run on call functions does NOT require an account | mech | P1+P3 | Agents on read-only machines can validate args | require account |
| 11 | DX | Include `value`/`gasLimit`/`voucherId` in dry-run output | taste | P1 | Round-trip diagnostics for agent debugging; cheap | minimal output |
| 12 | Eng | Defer README updates to TODOS | mech | P3 | Out of test gate; small follow-up PR | bundle docs |

## Cross-phase themes

- **Scope underspecified for `program.ts`** — flagged in CEO + Eng. Resolution: expand.
- **Stdin TTY edge case** — flagged in Eng + DX. Resolution: isTTY check.
- **Mode conflicts (estimate vs dry-run)** — flagged in Eng + DX. Resolution: explicit error.

## Approval

AUTO-APPROVED in spawned-session mode. Proceed to implementation.
