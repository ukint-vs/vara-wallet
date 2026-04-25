# Changelog

All notable changes to this project will be documented in this file.

## [0.15.0] - 2026-04-25

This release unifies the CLI surface that 0.11.x – 0.14.x grew organically. npm registry is on 0.10.0 when this ships, so the breaking changes below affect git-tracking users only — there are no published-version users using the renamed flags / fields. Take the cleanup now while it's free.

### Fixed
- **IDL auto-resolve from on-chain WASM** worked nowhere. `option.unwrap().toU8a()` in `tryExtractFromChain` (`src/services/sails.ts:355`) returned the bytes with a SCALE compact-length prefix, so the WASM-magic check downstream failed on every program with a confusing `IDL_PARSE_ERROR`. Fixed with `.toU8a(true)`. After this, v1 programs cleanly fall through to `IDL_NOT_FOUND` (and the `--idl` / `idl import` paths take over), and v2 programs get a real shot at the cache. Verified end-to-end against polybaskets contracts. New regression test: `src/__tests__/sails-extract-from-chain.test.ts` (5 tests, mocks the codec to assert `isBare=true` is used).
- **`call --dry-run` reported the wrong `encodedPayload`**. `txBuilder.payload` returns `this._tx.args[0].toHex()` in sails-js's `TransactionBuilder`, which is the destination program ID (the first arg of `api.message.send`), not the SCALE-encoded message. Field name lied about its contents. Fixed by using `func.encodePayload(...args)` — the canonical SCALE encoder on the function reference itself, mirroring the pattern queries already used. Also surfaces `destination: <hex>` as a separate field so callers see both pieces unambiguously.
- **`vft balance` and `vft allowance` crashed with `BigInt(null)`** when `findVftService` resolved to `VftExtension` (declared as `opt u256`) and the account had no balance / allowance row. Routed both through the existing `decodeSailsResult` walker (`src/utils/decode-sails-result.ts`, landed in #40); null surfaces as `'0'` in both `balance` and `balanceRaw` (matching on-chain semantics where a missing row is indistinguishable from zero). Closes the P2 item from `TODOS.md`.

### Added
- **`vara-wallet idl list`** — prints every cached IDL entry as `[{ codeId, version, source, importedAt, idlSizeBytes }, ...]`. Empty cache returns `[]`. Corrupted entries surface as `{ codeId, error: 'corrupted', ... }` rows so a single bad file never crashes the listing.
- **`vara-wallet idl remove <code-id>`** — removes one cache entry. Idempotent: removing a non-existent entry returns `{ removed: false, codeId }` and exit 0, not an error. Reuses the strict 32-byte hex validator from `idl import`.
- **`vara-wallet idl clear [--yes]`** — terraform-style: bare invocation prints a `wouldRemove` preview without unlinking; `--yes` commits. Snapshot-then-unlink under the hood: enumeration happens once, `ENOENT` during unlink is swallowed (race tolerance for parallel writers — cache is a recoverable resource so locking is over-engineering). `EACCES` surfaces as a clean `PERMISSION_DENIED` error code.
- **New helper `enumerateCacheEntries()` in `src/services/idl-cache.ts`** — single source of truth for the iteration shape, reused by both `idl list` and `idl clear` preview. Forward-compatible reads (optional chaining on every meta field) so a future writer adding fields, or a pre-this-PR entry missing some, never crashes.
- **`call --dry-run --estimate` now compose**. Both are read-only previews; the legacy mutex (`CONFLICTING_OPTIONS`) was overly restrictive. With both set the output merges `encodedPayload`, `destination`, and `estimateGas: { gasLimit, minLimit }` (account required, since estimate does need one). Pure `--estimate` keeps its lean shape unchanged so existing scripts parsing it stay working.
- **`pallet:` prefix on `--event`** — explicit way to force the pallet vocabulary even with an IDL loaded. Replaces the old `--pallet-event` flag with single-flag mental model. Example: `watch $PID --event pallet:UserMessageSent`. Bare names that match the legacy Gear vocab still resolve to the pallet path (back-compat unchanged).
- **Smoke test (`scripts/smoke.mjs`) extended** with 7 new bundled-CLI checks covering `idl list/import/remove/clear` happy paths. Catches bundling regressions (esbuild tree-shaking, export renames) that unit tests run against source can't see.

### Changed (breaking on the unreleased 0.11+ surface; no published-version users affected)
- **`--units` vocabulary unified to `human | raw` everywhere**. Before: native commands took `vara | raw` (default `vara`); VFT and DEX took `raw | token` (default `raw`). Two parallel idioms with inverse defaults and inverse polarity. Now: every command accepts `--units human | raw`. `human` means "interpret with the appropriate decimals for this command" — VARA's 12 for native, the token's declared decimals for VFT, LP decimals for `dex add-liquidity`/`remove-liquidity`. Per-command defaults stay (less in-context surprise: native still defaults to `human`, VFT/DEX still default to `raw`); only the vocabulary changes. **The literals `vara` and `token` are intentionally rejected by the validator** with `INVALID_UNITS` — catches stale scripts at the first `--units` pass instead of giving silent wrong-decimals math downstream. Centralized in `resolveAmount(amount, units?: string)` (was `(amount, unitsRaw: boolean)`).
- **`subscribe messages` flag `--type` renamed to `--event`** — same accepted values (Gear pallet name, Sails `Service/Event`, bare Sails event), unified with `watch` so the flag name doesn't depend on which subscribe sub-surface you happen to be in. One-line search/replace for any committed agent script.
- **NDJSON `sails:` field renamed to `decoded: { kind: 'sails', service, event, data }`** on `watch` and `subscribe messages` output. The `kind` discriminator future-proofs the surface so a second decoder type (e.g. EVM events) can sit alongside without renaming the top-level field again. Scripts parsing `.sails.event` should read `.decoded.event` and check `.decoded.kind === 'sails'`.

### Removed (breaking on the unreleased 0.11+ surface)
- **`--pallet-event` flag dropped** on `watch` and `subscribe messages`. Use `--event pallet:<EventName>` instead. The previous flag only mattered when a Sails event name collided with a pallet event name; the new prefix works the same way explicitly.

### Migration from 0.14.x (git users only — npm jumps from 0.10.0 → 0.15.0 in one go, no migration needed)
1. **`subscribe messages --type X` → `subscribe messages --event X`**. Same accepted values.
2. **`--pallet-event` → `--event pallet:<Name>`**. The `--pallet-event` flag stops working.
3. **NDJSON `.sails.*` → `.decoded.*`**, plus check `.decoded.kind === 'sails'` for forward-compat with future decoder types.
4. **`--units vara` (native commands) → `--units human`** (or omit; it's the default).
5. **`--units token` (VFT/DEX) → `--units human`**.
6. **`call --dry-run` JSON output**: the `encodedPayload` field now actually contains the SCALE-encoded call (was incorrectly the program ID); a separate `destination` field carries the program ID. Scripts that took `encodedPayload` and tried to use it as a program ID need to read `destination` instead.

## [0.14.1] - 2026-04-25

### Fixed
- `--json` mode no longer leaks `@polkadot` RPC-CORE disconnect warnings to stderr during shutdown. Previously `vara-wallet node info --json`, `balance --json`, etc. could emit `RPC-CORE: ...disconnected from wss://...` lines that broke downstream JSON parsers. The earlier `console.warn` patch in `src/services/api.ts` didn't fire because esbuild's module bundling put the logger's `console.error` call in a different scope, and the matcher was checking the wrong argument index. Replaced with a `process.stderr.write` interceptor matching the logger's timestamped `RPC-CORE:` prefix — bundle-scope-independent. `--verbose` output unaffected. (#34)
- TypeScript build of the same patch: `(chunk, ...rest)` signature didn't match the `process.stderr.write` overloads, so `ts-jest` failed to compile 7 test suites (esbuild bundling silently passed, masking the issue in `npm run build`). Reworked the wrapper to a single rest-parameter form that satisfies both overloads.

## [0.14.0] - 2026-04-24

### Added
- IDL-aware Sails event decoding in `watch` and `subscribe messages` (closes #36). Loading an IDL (explicitly via `--idl <path>` or auto-resolved from chain WASM) augments each emitted `UserMessageSent` with a `sails: {service, event, data}` block. Existing raw fields (`payload`, `source`, `destination`, etc.) are untouched, so consumers that already parse the raw NDJSON keep working.
- `--event <Service/Event>` and bare-name Sails event filters on both `watch` and `subscribe messages`. Gear pallet vocabulary (`UserMessageSent`, `MessageQueued`, etc.) still resolves to the legacy pallet path first so existing scripts keep working. Ambiguous bare Sails names hard-fail with `AMBIGUOUS_EVENT` and list the alternatives.
- `--pallet-event` flag on `watch` / `subscribe messages` to force Gear pallet event resolution even when an IDL is loaded, and `--no-decode` to disable the opportunistic IDL auto-load entirely.
- Decoded Sails events are appended to the `call` JSON response under a new `events: [...]` key (closes #37). The event scan is phase-correlated to the submitting extrinsic, so cross-transaction events that share the block are excluded. Additive — existing response fields (`txHash`, `blockHash`, `messageId`, `result`, ...) are unchanged.
- New `src/services/sails-events.ts` module exposing `decodeSailsEvent`, `listEventNames`, `resolveEventName`, and `collectDecodedEvents`. Recursively walks v2 `service.extends`, so events declared in an inherited service are discoverable in filter resolution and decoding.
- Decoded event payloads flow through the shared `decodeEventData` walker (alias of `decodeSailsResult` from #32), so nested `Option<U256>`, `Vec<U256>`, and user-defined types normalize to the same JSON shape as `call` replies.
- `--args-file <path>` on `call`, `encode`, `program upload`, and `program deploy` reads the JSON args from a file instead of the `--args` string. Use `-` for stdin (`echo '[...]' | vara-wallet call ... --args-file -`). Eliminates shell-escape failures when nested JSON contains hex actor IDs or 64-byte `vec u8` signatures (the failure mode that surfaced as `{"error":"[object Object]","code":"UNKNOWN_ERROR"}` during 2026-04-23 live testing). Closes [#20](https://github.com/gear-foundation/vara-wallet/issues/20).
- `--dry-run` on `call`, `program upload`, and `program deploy`: encode the SCALE payload and exit without signing or submitting. Output includes the encoded hex, resolved constructor name (for upload/deploy), and `willSubmit: false`. Works without a wallet configured — agents can preview payloads on read-only machines.

### Changed
- `--args` and `--args-file` are mutually exclusive (`code: INVALID_ARGS_SOURCE`). `--estimate` and `--dry-run` are mutually exclusive on `call` (`code: CONFLICTING_OPTIONS`). Malformed-JSON errors from `--args-file` never echo the file path or content (file may contain test seeds); error reports parse position only.
- Stdin (`--args-file -`) rejects fast with `STDIN_IS_TTY` when no pipe is attached, instead of hanging waiting for EOF — common AI-agent footgun.

## [0.13.0] - 2026-04-24

### Added
- Auto-resolve IDL from on-chain WASM for v2 programs (sails ≥ 1.0.0-beta.1): `vara-wallet call` and `vara-wallet discover` now work on any such program without `--idl`. IDL is extracted from the `sails:idl` custom section of the program's original WASM via `gearProgram.originalCodeStorage(codeId)`.
- Local IDL cache at `~/.vara-wallet/idl-cache/<codeId>.cache.json`. First call against a program fetches the WASM and populates the cache; subsequent calls are free.
- `vara-wallet idl import <path.idl> (--code-id <hex> | --program <hex|ss58>)` command for seeding the cache with out-of-band IDLs (v1 programs, or any case where the on-chain WASM doesn't carry the section).
- IDL cache entries are validator-gated on read for `vft`/`dex` commands: if a cached IDL fails the caller's validator (e.g. a bad `idl import` against a VFT program), the entry is evicted and the bundled fallback is tried. Preserves the pre-cache safety contract.
- Strict validation on `--code-id` input (32-byte hex, with or without `0x` prefix) — rejects path-traversal attempts and malformed hex before they reach the cache layer.

### Removed / Breaking
- **`metaStorageUrl` config key and `VARA_META_STORAGE` env var are gone.** `vara-wallet config set metaStorageUrl <url>` now errors with `INVALID_CONFIG_KEY`. Empirically the meta-storage endpoint returned 0/13 usable IDLs during 2026-04-23 testing; the new WASM-custom-section path replaces it for v2, and `idl import` replaces it for v1. Stale entries in existing `~/.vara-wallet/config.json` files are silently ignored (no migration required).

### Internal
- Extracted `writeUserFile` / `writeUserFileAtomic` helpers to `src/utils/secure-file.ts`; `config.ts`, `wallet-store.ts`, and the new `idl-cache.ts` share the "mode 0700 parent + mode 0600 file" idiom.

## [0.12.0] - 2026-04-23

### Added
- `call`, `encode`, and `program deploy` now accept SS58 addresses (`5Grw...`) in `--args` for any `ActorId`-typed positional or struct-nested argument. Previously only 32-byte hex was accepted, forcing users to manually decode addresses copied from Subscan before passing them to Sails methods like `Vft/BalanceOf`. Canonical hex input remains byte-identical on the wire. Closes [#31](https://github.com/gear-foundation/vara-wallet/issues/31).

### Fixed
- `call --json` now recursively decodes nested `U256` / `u128` / `u64` into decimal strings when they appear inside `Option`, `Vec`, tuples, structs, enums, `Result`, or user-defined types. Previously only top-level primitives decoded correctly; nested numeric leaves leaked as raw `0x...` hex. Same fix applied to `vft` and `dex` transaction responses (#32).
- `VftExtension/BalanceOf` now returns `{"result": "186726170"}` (or `null`) instead of a 32-byte hex blob.
- `VftExtension/Allowances` now returns fully-decoded nested arrays — every inner `U256` is a decimal string, tuples stay as arrays, `ActorId` entries stay hex.
- Faucet test suite no longer reads the developer's real `~/.vara-wallet/config.json`. The mainnet guard at `faucet.ts:49` was triggering on any dev machine with a mainnet `wsEndpoint` configured, failing 6 tests locally even though CI stayed green.

### Changed
- **Breaking (for anyone parsing raw hex from `--json` output):** the shape of `result` now matches the declared IDL return type at every level. Callers that expected `"0x..."` for nested `U256` must read the decimal string instead. Top-level primitives (`Vft/TotalSupply`, `VftMetadata/Symbol`) are unchanged.

## [0.11.0] - 2026-04-22

### Added
- `wallet keys <name>` command: export raw key material (`address`, `publicKey`, `secretKeyPkcs8`, `type`) for use with Polkadot tooling
- `transfer --all` flag: drain the entire account via Substrate's native `transferAll` extrinsic (no client-side fee/ED math)

### Changed
- **CLI is now bundled with esbuild into a single `dist/app.js`.** Runtime dependencies shrink from ~120 transitive packages to 2 (`better-sqlite3`, `smoldot`). Fixes reports of `npm install -g vara-wallet` hanging for minutes on slow networks, where npm's retry policy turned stalled tarball fetches into multi-minute retry storms. Global install is now ~2 MB gzipped and a few seconds on any network.
- **Node.js 20 or newer is now required** (`engines: { node: ">=20" }`). Matches the existing CI matrix.
- Build script: `npm run build` now invokes `node scripts/build.mjs` instead of `tsc`.

## [0.10.0] - 2026-04-09

### Added
- Auto-convert hex strings (e.g., `"0xabcdef..."`) to byte arrays for `vec u8` and `[u8; N]` IDL types in Sails calls — no more Python workarounds for binary arguments
- `encode` command works offline when `--idl` is provided without `--program`

### Fixed
- Sails program errors now surface with readable messages and `PROGRAM_ERROR` error code instead of `[object Object]`
- `formatError()` fallback properly serializes non-Error objects via `JSON.stringify`

### Changed
- Repository URLs updated from `ukint-vs` to `gear-foundation`

## [0.9.0] - 2026-04-02

### Added
- `config` command: persist CLI settings with `config set/get/list` (network, default account, meta-storage URL)
- `--network` global option: switch networks with `--network testnet` instead of typing full WS URLs
- `--estimate` flag on `call`: preview gas cost without sending the transaction
- Connection timeout (10s) on WebSocket and light client: bad endpoints fail fast instead of hanging
- `balance` and `transfer` output now includes `addressSS58` with chain-aware SS58 encoding
- `program list` defaults to 100 results (use `--all` for unlimited)
- Global timeout on `subscribe` commands fires before connection, so `--timeout` always works
- Empty `events list` prints a hint (via `--verbose`) suggesting `subscribe` first
- Faucet refuses mainnet endpoints with a clear error before connecting
- Better `discover` error message with actionable IDL suggestions

### Changed
- Endpoint resolution now includes config fallback: `--ws` > `--network` > `VARA_WS` > config > default
- Stderr RPC-CORE disconnect warnings are filtered during shutdown (no more noise in agent output)
- `program upload` help text explains Sails constructor encoding with `--idl`/`--init`/`--args`

## [0.8.0] - 2026-04-02

### Added
- `--idl`, `--init`, `--args` options on `program upload` and `program deploy` for automatic Sails constructor payload encoding
- Auto-selects constructor when IDL has exactly one; lists available constructors when multiple exist
- Constructor argument count validation prevents silent zero-fill on missing args
- `parseIdlFile()` utility for offline IDL parsing without API connection
- 14 new tests covering all constructor encoding paths and error cases

## [0.7.0] - 2026-03-31

### Added
- `faucet` command: request testnet TVARA tokens with challenge-sign-claim flow that proves address ownership
- Faucet defaults to testnet RPC (`wss://testnet.vara.network`) so no `--ws` flag needed
- Configurable faucet URL via `--faucet-url`, `VARA_FAUCET_URL` env var, or `config.faucetUrl`
- Balance pre-check skips request if account already has >= 1000 TVARA

## [0.6.0] - 2026-03-31

### Added
- `--voucher <id>` flag on write commands: `call`, `message send`, `message reply`, `vft transfer/approve/transfer-from/mint/burn`, `dex swap/add-liquidity/remove-liquidity`, and `code upload`
- Preflight voucher validation checks format, existence, and program restrictions before submitting transactions
- Clear error when `--voucher` is used with query methods (read-only calls don't use vouchers)
- Voucher ID included in JSON output (`voucherId` field) when a voucher is used
- 8 new unit tests for voucher validation (format, program mismatch, unrestricted vouchers)

## [0.5.1] - 2026-03-27

### Fixed
- `wallet import --seed '//Alice'` (and other SURI strings) now works correctly — Commander.js was consuming `--seed` at the global level before the subcommand could parse it, causing a `MISSING_IMPORT_SOURCE` error
- Same fix applies to `--mnemonic` on the import subcommand

## [0.5.0] - 2026-03-26

### Added
- `sign` command for signing arbitrary data with your wallet key (raw sr25519, no `<Bytes>` wrapping)
- `verify` command for verifying signatures against data and an address
- Both commands support UTF-8 string and hex (`--hex`) input, with strict hex validation
- Sign output includes `cryptoType` for interop transparency

## [0.4.0] - 2026-03-25

### Added
- You can now trade tokens on Vara's DEX (Rivr) with `dex swap`, `dex quote`, `dex pool`, `dex pairs`, `dex add-liquidity`, and `dex remove-liquidity`
- Swaps auto-approve input tokens — one command to trade, no separate approval step needed (`--skip-approve` to opt out)
- Slippage protection in basis points (default 1%) with price impact warnings when >5%
- Bundled DEX IDLs work offline — no `--idl` flag needed for standard vara-amm contracts
- Optimal liquidity calculations handle off-ratio deposits automatically
- `dexFactoryAddress` config field persists your factory address across sessions
- 20 new unit tests covering slippage math, price impact, and IDL parsing

## [0.3.2] - 2026-03-25

### Fixed
- Use fresh Sails instance for bundled IDL probing to avoid mutating shared state
- Remove unused `_parser` parameter from `resolveIdl`
- Reject non-zero fractional input in `toMinimalUnits` when `decimals` is 0 (allows `"1.0"`)

## [0.3.1] - 2026-03-25

### Added
- Bundle two standard VFT IDLs enabling `vft` commands without `--idl` or meta-storage
- Bundled IDL fallback in `loadSails()` with method-validated resolution via `idlValidator` callback
- `toMinimalUnits()` utility for safe decimal-to-minimal-unit conversion with arbitrary decimals
- `vft info` command for querying token name, symbol, decimals, and total supply
- `vft allowance` command for querying token allowances
- `vft transfer-from` command for approved token transfers
- `vft mint` command for admin token minting
- `vft burn` command for admin token burning
- `--units raw|token` option on all VFT transaction commands for human-readable amount input
- Unit tests for bundled IDL parsing and `toMinimalUnits` (13 new tests)

## [0.3.0] - 2026-03-18

### Added
- Subscribe command with SQLite event persistence for monitoring on-chain events
- Block numbers and readable values to CLI outputs

### Fixed
- Message send to user wallet failing with TX_FAILED
- Read CLI version from package.json instead of hardcoded string

## [0.2.0] - 2026-03-17

### Added
- Embedded light client (smoldot) for trustless chain access
- Accept both hex and SS58 addresses as CLI arguments

### Fixed
- Use normalized hex address in voucher revoke output
- Message send accepts any destination, not just programs

## [0.1.2] - 2026-03-17

### Fixed
- Resolve @polkadot/util duplicate version warnings

## [0.1.1] - 2026-03-17

### Fixed
- Don't use passphrase on unencrypted wallet

## [0.1.0] - 2026-03-17

### Added
- Initial release of vara-wallet CLI
- Wallet management (create, import, list, info)
- Token transfers and balance queries
- Program deployment and message sending
- Voucher management
- Mailbox operations
- Sails IDL-based service interaction
