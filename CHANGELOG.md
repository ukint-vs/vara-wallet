# Changelog

All notable changes to this project will be documented in this file.

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
