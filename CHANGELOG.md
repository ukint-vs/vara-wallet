# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

Agent-UX hardening surfaced by a field report from a betting agent and an adversarial cross-model review (Codex). Three layers: structured gas-estimate errors, arity-aware args validation, sharper IDL diagnostics.

### Added

- **`INVALID_ARGS_FORMAT` error code** for `call`, `program upload/create`, and `encode --method`. Sails methods take positional args; passing a top-level JSON object (named-arg shorthand) to a multi-arg method now errors before reaching the codec instead of silently wrapping into `[obj]` and producing cryptic codec errors. 1-arg struct methods preserve the bare-object shorthand: `'{"field":...}'` and `'[{"field":...}]'` both work.
- **`INVALID_ADDRESS` for non-string `actor_id` field values.** Plain objects passed where an `actor_id` is expected now error at the codec layer with a field-named message: `Invalid ActorId for "<field>": expected hex string, SS58 address, or 32-byte array, got object: {...}`. Replaces the previous "Expected 32 bytes, found 15 bytes" mystery.
- **Structured `meta` on `PROGRAM_ERROR`.** When `calculateGas` reverts because the program panicked or hit `unreachable`, the error now includes `reason` (`panic` / `unreachable` / `inactive` / `not_found`) and `programMessage` (contract error variant name). Agents can switch on `.programMessage` directly instead of regex-matching English.

### Changed

- **`IDL_NOT_FOUND` error wording is now precise.** When the on-chain WASM is readable but has no `sails:idl` custom section, the error explicitly says "This is a v1 contract" and points at `vara-wallet idl import`. The previous message hedged "may be v1 or sails < 1.0.0-beta.1" with no way to tell.
- **`calculateGas` failures are classified everywhere.** Wrapped at all 8 auto-calc sites (call, program init upload/create, message reply, dex approve/reset/exec, vft exec). Cross-program transfer panics in PolyBaskets / VFT contexts (e.g. `BetTokenTransferFromFailed` from insufficient allowance) now surface with `code: PROGRAM_ERROR + reason: panic + programMessage: <variant>` instead of opaque "gas calculation failed" text.
- **`message send` to a user-account destination still works** (gas=0 fallback preserved). The handle path now uses targeted error classification: `reason: not_found` (older gear-node spec) and `reason: unreachable` with the substring `Failed to get last message from the queue` (gear-node spec 11000+) both fall back to `gasLimit = 0n`. Real program panics rethrow with structured info instead of being silently swallowed.

### Fixed

- **`programMessage` strips the `Result::unwrap` wrapper** (issue #55). Sails contracts using `#[export(unwrap_result)]` (the standard pattern for typed `Result<T, EnumError>` returns) emit panics in the form `called \`Result::unwrap()\` on an \`Err\` value: <Variant>`. The classifier now extracts the bare variant so agents can `case "$pm" in NoItems)` switch on it without substring matching. Variants with payloads (`InsufficientBalance(100)`) pass through whole; full original wrapper stays in `error` for debugging. Test fixture updated to the wrapped production shape so the regression guard is real, not synthetic.
- **`package-lock.json` synced to v0.15.0.** The lockfile drifted at the v0.15.0 release.

## [0.15.0] - 2026-04-25

First publish since 0.10.0. This release collapses the work that landed in git as 0.11 / 0.12 / 0.13 / 0.14 / 0.14.1 (none reached npm) into a single coherent surface, plus the UX cleanup that surfaced when documenting them. Upgrading from 0.10.0: install fresh, no migration needed.

### Added

**IDL surface**
- `idl import <path.idl> (--code-id <hex> | --program <hex|ss58>)` — seed the local IDL cache for v1 programs or out-of-band IDLs.
- `idl list` — print every cached IDL entry as `[{ codeId, version, source, importedAt, idlSizeBytes }]`. Corrupted entries surface as `{ codeId, error: 'corrupted', ... }` rows so a single bad file never crashes the listing.
- `idl remove <code-id>` — remove one entry. Idempotent: missing entries return `{ removed: false }` and exit 0.
- `idl clear [--yes]` — terraform-style: bare invocation prints a `wouldRemove` preview without unlinking; `--yes` commits. `EACCES` surfaces as `PERMISSION_DENIED`.
- Auto-resolve IDL from on-chain WASM for v2 programs (sails ≥ 1.0.0-beta.1): `call` and `discover` work without `--idl`. Extracted from the `sails:idl` custom section of the program's WASM via `gearProgram.originalCodeStorage(codeId)`. Cached at `~/.vara-wallet/idl-cache/<codeId>.cache.json`; subsequent calls skip the fetch. Cache entries are validator-gated for `vft`/`dex` — a poisoned import gets evicted on first validator miss.

**Call surface**
- `call --dry-run` — encode the SCALE payload and exit without signing or submitting. Output: `{ kind, service, method, args, encodedPayload, destination, value, gasLimit, voucherId, willSubmit: false }`. Works without a wallet.
- `call --estimate --dry-run` compose: same dry-run shape with `estimateGas: { gasLimit, minLimit }` appended (account required since estimate needs one).
- `--args-file <path>` on `call`, `encode`, `program upload`, `program deploy` — read JSON args from a file (`-` for stdin). Eliminates shell-escape failures with nested JSON, hex actor IDs, or 64-byte `vec u8` signatures. Mutually exclusive with `--args` (`INVALID_ARGS_SOURCE`); stdin without a pipe attached fails fast with `STDIN_IS_TTY`.
- `--dry-run` on `program upload` and `program deploy` — encode the constructor payload + report resolved constructor name without uploading.
- SS58 addresses (`5Grw...`) accepted in `--args` for any `ActorId`-typed positional or struct-nested argument. Canonical hex input remains byte-identical on the wire.
- `events: [...]` field on `call` JSON response with phase-correlated decoded Sails events.
- Cross-service hint on `METHOD_NOT_FOUND` ("Did you mean `OtherService/Method`?").
- `PROGRAM_ERROR` carries a structured `reason` subcode for both function calls and queries.

**Subscribe / watch**
- IDL-aware event decoding: when an IDL is loaded, `UserMessageSent` events get a `decoded: { kind: 'sails', service, event, data }` block alongside the raw fields. Additive — consumers parsing raw NDJSON keep working. The `kind` discriminator future-proofs the surface for additional decoder types.
- `--event` filter on both `watch` and `subscribe messages` accepts: Gear pallet event names, qualified `Service/Event`, bare Sails event names (when unambiguous across services), or `pallet:<Name>` to force pallet vocabulary even with an IDL loaded. Ambiguous bare Sails names hard-fail with `AMBIGUOUS_EVENT` listing the alternatives.
- `--no-decode` to disable the opportunistic IDL auto-load entirely.
- New `src/services/sails-events.ts` module exposing `decodeSailsEvent`, `listEventNames`, `resolveEventName`, `collectDecodedEvents`. Walks v2 `service.extends` recursively.

**Wallet / chain**
- `wallet keys <name>` — export raw key material (`address`, `publicKey`, `secretKeyPkcs8`, `type`) for Polkadot tooling.
- `transfer --all` — drain the entire account via Substrate's native `transferAll` extrinsic (no client-side fee/ED math).

### Fixed
- IDL auto-resolve from on-chain WASM was broken on every program: `option.unwrap().toU8a()` returned bytes with a SCALE compact-length prefix, so the WASM-magic check failed with a confusing `IDL_PARSE_ERROR`. Fixed with `.toU8a(true)`. Verified end-to-end against polybaskets contracts.
- `call --dry-run` `encodedPayload` reported the destination program ID instead of the actual SCALE-encoded message (sails-js's `txBuilder.payload` is `args[0].toHex()`, not the encoded call). Fixed by using `func.encodePayload(...args)`. The destination program ID is now surfaced separately as `destination`.
- `vft balance` and `vft allowance` crashed with `BigInt(null)` when `findVftService` resolved to `VftExtension.BalanceOf` (declared `opt u256`) for accounts with no balance row. Routed through `decodeSailsResult`; null surfaces as `'0'`.
- Nested `U256` / `u128` / `u64` inside `Option`, `Vec`, tuples, structs, enums, `Result`, or user-defined types now decode to decimal strings recursively (was: leaked as raw `0x...` hex). Applies to `call`, `vft`, and `dex` responses.
- Sails program errors surface readable messages with `PROGRAM_ERROR` instead of `[object Object]`.
- `--json` mode no longer leaks `@polkadot` RPC-CORE disconnect warnings to stderr during shutdown. Filter intercepts at `process.stderr.write` (bundle-scope-independent).
- `formatError()` fallback properly serializes non-Error objects via `JSON.stringify`.

### Changed (breaking against 0.10.0 only where noted)

- **CLI is bundled to a single `dist/app.js`** with esbuild. Runtime dependencies shrink from ~120 transitive packages to 2 (`better-sqlite3`, `smoldot`). Fixes the `npm install -g vara-wallet` hangs reported in 0.10. Global install is now ~2 MB gzipped.
- **Node.js 20 or newer required** (`engines: { node: ">=20" }`). Breaking for any user still on Node 18 or older.
- **`--units` vocabulary unified to `human | raw`** across every command (was: `vara | raw` for native, `raw | token` for VFT/DEX). `human` interprets with the appropriate decimals — VARA's 12 for native, the token's declared decimals for VFT, LP decimals for `dex add-liquidity`/`remove-liquidity`. Per-command defaults preserved (native still defaults to `human`, VFT/DEX still default to `raw`); only the literal name changes. **The legacy literals `vara` and `token` are rejected with `INVALID_UNITS`** — agents copying old `--units vara` invocations get a clear validator error, not silent wrong-decimals math.
- **`metaStorageUrl` config key and `VARA_META_STORAGE` env var are removed.** `config set metaStorageUrl <url>` errors with `INVALID_CONFIG_KEY`. Empirically the endpoint returned near-zero usable IDLs; the new WASM-custom-section auto-resolve replaces it for v2, `idl import` replaces it for v1. Stale entries in existing config files are silently ignored.

### Internal
- Build script: `npm run build` invokes `node scripts/build.mjs` (was: `tsc`).
- Extracted `writeUserFile` / `writeUserFileAtomic` helpers to `src/utils/secure-file.ts`; `config.ts`, `wallet-store.ts`, and `idl-cache.ts` share the "mode 0700 parent + mode 0600 file" idiom.
- New regression tests for the on-chain IDL extraction (`sails-extract-from-chain.test.ts`), dry-run encoding contract (`dry-run.test.ts` extended), VFT null-safety (`vft-balance-null-safety.test.ts`), and IDL cache list/remove/clear (`idl-list-remove-clear.test.ts`). 525 → 563 tests.

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
