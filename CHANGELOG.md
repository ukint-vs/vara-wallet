# Changelog

All notable changes to this project will be documented in this file.

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
