# vara-wallet

Agentic wallet CLI for Vara Network — designed for AI coding agents.

All output is structured JSON by default. No interactive prompts. Wallets are encrypted automatically with zero setup required.

## Quick Start

```bash
# Install
npm install -g vara-wallet

# Create a wallet (auto-generates passphrase, encrypts, no secrets shown)
vara-wallet wallet create --name my-wallet

# Check balance
vara-wallet balance

# Transfer VARA
vara-wallet transfer <destination> 10

# Interact with a Sails program
vara-wallet call <programId> Service/Method --args '["arg1", "arg2"]'

# Pass hex strings for binary args — auto-converted to byte arrays
vara-wallet call <programId> Service/Upload --args '["0xdeadbeef"]'

# Pass SS58 or hex addresses for ActorId args — SS58 auto-normalized to hex
vara-wallet call <programId> Vft/BalanceOf --args '["5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"]'
```

## Installation

Requires Node.js 20 or newer.

```bash
npm install -g vara-wallet
```

The CLI ships as a single bundled file (~2 MB gzipped) with only two runtime dependencies (`better-sqlite3` and `smoldot`), so global install is a few seconds on any network.

### From source

```bash
git clone https://github.com/gear-foundation/vara-wallet.git
cd vara-wallet
npm install --legacy-peer-deps
npm run build
npm link
```

## Global Options

```
--ws <endpoint>       WebSocket endpoint (default: wss://rpc.vara.network)
--light               Use embedded light client (smoldot) instead of WebSocket
--seed <seed>         Account seed (SURI like //Alice or hex)
--mnemonic <mnemonic> Account mnemonic phrase
--account <name>      Wallet name to use
--json                Force JSON output
--human               Force human-readable output
--quiet               Suppress all output except errors
--verbose             Show debug info on stderr
--network <name>      Network shorthand: mainnet, testnet, or local
```

`--network` maps to the well-known WS endpoint for each network. Cannot be used with `--ws`.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VARA_WS` | WebSocket endpoint | `wss://rpc.vara.network` |
| `VARA_SEED` | Account seed | — |
| `VARA_MNEMONIC` | Account mnemonic | — |
| `VARA_LIGHT` | Set to `1` to use embedded light client (smoldot) | — |
| `VARA_PASSPHRASE` | Wallet passphrase (CI/Docker fallback) | — |
| `VARA_WALLET_DIR` | Config directory | `~/.vara-wallet` |
| `VARA_DEX_FACTORY` | DEX factory program address | — |
| `VARA_FAUCET_URL` | Faucet API URL | `https://faucet.gear-tech.io` |

## Account Resolution

When a command needs a signing account, it checks in order:

1. `--seed` flag
2. `VARA_SEED` env var
3. `--mnemonic` flag
4. `VARA_MNEMONIC` env var
5. `--account` flag (loads wallet file)
6. Default account from config

## Wallet Encryption

Wallets are encrypted by default using Polkadot's xsalsa20-poly1305 + scrypt KDF.

**Passphrase resolution for decryption:**
1. `~/.vara-wallet/.passphrase` file (primary — agent never sees it)
2. `VARA_PASSPHRASE` env var (fallback for CI/Docker)

**On first `wallet create`:** If no passphrase source exists, a random 256-bit passphrase is auto-generated and saved to `~/.vara-wallet/.passphrase` with `0600` permissions. The agent never sees the passphrase value.

```bash
# Zero-setup: just works
vara-wallet wallet create --name agent-key
# Passphrase auto-generated, wallet encrypted, secrets suppressed

# Human override
vara-wallet wallet create --name human-key --passphrase "memorable-phrase"

# Opt out of encryption (not recommended)
vara-wallet wallet create --name unsafe --no-encrypt --show-secret
```

## Commands

### `init`

Initialize wallet infrastructure with a default wallet.

```bash
vara-wallet init [--name <name>]
```

### `faucet`

Request testnet TVARA tokens. Proves address ownership via a challenge-sign-claim flow. Automatically connects to testnet RPC.

```bash
vara-wallet faucet [address] [--faucet-url <url>]
```

Skips the request if the account already has >= 1000 TVARA. Faucet URL resolves from: `--faucet-url` flag > `VARA_FAUCET_URL` env > `config.faucetUrl` > default.

### `wallet`

```bash
vara-wallet wallet create [--name <n>] [--passphrase <p>] [--no-encrypt] [--show-secret]
vara-wallet wallet import [--name <n>] [--mnemonic <m>] [--seed <s>] [--json <path>] [--passphrase <p>] [--no-encrypt]
vara-wallet wallet list
vara-wallet wallet export <name> [--decrypt] [--output <path>]
vara-wallet wallet keys <name>
vara-wallet wallet default [name]
```

`wallet keys` outputs the raw key material: `{ address, publicKey, secretKeyPkcs8, type }`. The PKCS8 blob contains the full secret key and can be used with Polkadot tooling to reconstruct the keypair. This is a sensitive operation — the secret key is exposed in the output. For a redacted export suitable for sharing, use `wallet export`.

### `node`

```bash
vara-wallet node info
```

### `balance` / `transfer`

```bash
vara-wallet balance [address]
vara-wallet transfer <to> <amount> [--units vara|raw]
vara-wallet transfer <to> --all
```

`--all` drains the entire account via Substrate's native `transferAll` extrinsic (no client-side fee/ED math). Without `--all`, transfers use `transferKeepAlive`. `--all` and an explicit amount are mutually exclusive.

### `message`

```bash
vara-wallet message send <destination> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--metadata <path>] [--voucher <id>]
vara-wallet message reply <messageId> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--metadata <path>] [--voucher <id>]
vara-wallet message calculate-reply <programId> [--payload <hex>] [--value <v>] [--units vara|raw] [--origin <addr>] [--at <blockHash>]
```

Gas is auto-calculated if `--gas-limit` is omitted. Destination can be any actor (program, user, wallet). Use `--value` to transfer VARA tokens alongside a message. Use `--voucher <id>` to pay for the message using a voucher instead of the sender's balance.

### `program`

```bash
vara-wallet program upload <wasm> [--payload <hex>] [--idl <path>] [--init <name>] [--args <json> | --args-file <path>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--salt <hex>] [--metadata <path>] [--dry-run]
vara-wallet program deploy <codeId> [--payload <hex>] [--idl <path>] [--init <name>] [--args <json> | --args-file <path>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--salt <hex>] [--metadata <path>] [--dry-run]
vara-wallet program info <programId>
vara-wallet program list [--count <n>] [--all]
```

Use `--idl` to auto-encode the constructor payload from a Sails IDL file. The constructor is auto-selected if the IDL has only one; use `--init <name>` when multiple constructors exist. `--args` passes constructor arguments as a JSON array, or use `--args-file <path>` to read JSON from a file (or `-` for stdin). `--payload` and `--idl` are mutually exclusive. `--dry-run` encodes the constructor payload and exits without signing or submitting; the response reports the resolved constructor name, encoded hex, and `willSubmit: false`.

```bash
# Deploy with IDL-based constructor encoding (auto-selects "New" constructor)
vara-wallet program upload ./demo.opt.wasm --idl ./demo.idl --args '["MyToken", "MTK", 18]'

# Explicit constructor name
vara-wallet program upload ./demo.opt.wasm --idl ./demo.idl --init New --args '["MyToken", "MTK", 18]'

# Deploy from existing code ID
vara-wallet program deploy 0xCODE_ID --idl ./demo.idl --args '["MyToken", "MTK", 18]'
```

### `code`

```bash
vara-wallet code upload <wasm> [--voucher <id>]
vara-wallet code info <codeId>
vara-wallet code list [--count <n>]
```

### `call` (Sails)

High-level method invocation on Sails programs. Auto-detects queries vs functions. Use `--estimate` to calculate gas cost without sending the transaction (requires an account). Use `--dry-run` to encode the SCALE payload and exit without signing or submitting (works without a wallet — useful for previewing payloads on read-only machines).

```bash
vara-wallet call <programId> <Service/Method> [--args <json> | --args-file <path>] [--value <v>] [--units vara|raw] [--gas-limit <n>] [--idl <path>] [--voucher <id>] [--estimate | --dry-run]
```

For v2 programs (sails ≥ 1.0.0-beta.1) the IDL is auto-resolved from the program's on-chain WASM — `--idl` is only needed for v1 programs or when overriding with a local file. Resolved IDLs are cached under `~/.vara-wallet/idl-cache/` so subsequent calls skip the fetch.

`--args-file <path>` reads the JSON args from a file instead of the `--args` string; use `-` for stdin (`echo '[...]' | vara-wallet call ... --args-file -`). Eliminates shell-escape failures with nested JSON containing hex actor IDs or 64-byte `vec u8` signatures. Mutually exclusive with `--args` (`INVALID_ARGS_SOURCE`). `--estimate` and `--dry-run` are mutually exclusive (`CONFLICTING_OPTIONS`).

The JSON response includes an `events: [...]` field with any decoded Sails events emitted by the call, phase-correlated to the submitting extrinsic (cross-transaction events from the same block are excluded). Nested numeric leaves (`U256`, `u128`) inside `Option`, `Vec`, tuples, structs, enums, `Result`, or user types are recursively decoded to decimal strings to match the declared IDL return type.

### `discover` (Sails)

Introspect a Sails program's services, functions, queries, and events.

```bash
vara-wallet discover <programId> [--idl <path>]
```

Same auto-resolution as `call`.

### `idl` (Sails IDL cache)

Seed the local IDL cache with an out-of-band IDL. Needed for v1 programs (no embedded IDL in WASM) and for one-off imports. Once imported, `call`/`discover`/`vft`/`dex` find the IDL automatically for that program's `codeId`.

```bash
# Import an IDL for a specific program (resolves codeId via RPC)
vara-wallet idl import ./my-program.idl --program <programId>

# Import for a known codeId — fully offline
vara-wallet idl import ./my-program.idl --code-id 0x<hex>
```

### `vft` (Fungible Tokens)

Works out of the box with standard VFT programs — no `--idl` needed (bundled IDL fallback).

```bash
vara-wallet vft info <tokenProgram> [--idl <path>]
vara-wallet vft balance <tokenProgram> [account] [--idl <path>]
vara-wallet vft allowance <tokenProgram> <owner> <spender> [--idl <path>]
vara-wallet vft transfer <tokenProgram> <to> <amount> [--idl <path>] [--units raw|token] [--voucher <id>]
vara-wallet vft approve <tokenProgram> <spender> <amount> [--idl <path>] [--units raw|token] [--voucher <id>]
vara-wallet vft transfer-from <tokenProgram> <from> <to> <amount> [--idl <path>] [--units raw|token] [--voucher <id>]
vara-wallet vft mint <tokenProgram> <to> <amount> [--idl <path>] [--units raw|token] [--voucher <id>]
vara-wallet vft burn <tokenProgram> <from> <amount> [--idl <path>] [--units raw|token] [--voucher <id>]
```

Use `--units token` to pass human-readable amounts (e.g., `1.5` → auto-converts using on-chain decimals). Default is `raw` (minimal units).

### `dex` (DEX Trading)

Trade tokens on the vara-amm decentralized exchange (Rivr DEX). Works with bundled IDLs — no `--idl` needed. Requires a factory address via `--factory`, `VARA_DEX_FACTORY` env, or `dexFactoryAddress` in config.

Rivr DEX testnet factory: `0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e`

```bash
vara-wallet dex pairs [--factory <addr>] [--limit <n>]
vara-wallet dex pool <token0> <token1> [--factory <addr>]
vara-wallet dex quote <tokenIn> <tokenOut> <amount> [--reverse] [--units raw|token]
vara-wallet dex swap <tokenIn> <tokenOut> <amount> [--slippage <bps>] [--deadline <s>] [--exact-out] [--skip-approve] [--voucher <id>]
vara-wallet dex add-liquidity <token0> <token1> <amount0> <amount1> [--slippage <bps>] [--deadline <s>] [--skip-approve] [--voucher <id>]
vara-wallet dex remove-liquidity <token0> <token1> <liquidity> [--slippage <bps>] [--deadline <s>] [--skip-approve] [--voucher <id>]
```

Slippage is in basis points (100 = 1%, default). Swaps auto-approve input tokens unless `--skip-approve` is set. Use `--units token` to pass human-readable amounts.

### `voucher`

```bash
vara-wallet voucher issue <spender> <value> [--units vara|raw] [--duration <blocks>] [--programs <ids>]
vara-wallet voucher list <account> [--program <id>]
vara-wallet voucher revoke <spender> <voucherId>
```

### `mailbox`

```bash
vara-wallet mailbox read [address]
vara-wallet mailbox claim <messageId>
```

### `state`

```bash
vara-wallet state read <programId> [--payload <hex>] [--origin <addr>] [--at <blockHash>]
```

### `tx` / `query` (Generic Substrate)

```bash
vara-wallet tx <pallet> <method> [args...]
vara-wallet query <pallet> <method> [args...]
```

### `wait`

Wait for a reply to a message.

```bash
vara-wallet wait <messageId> [--timeout <seconds>]
```

### `subscribe`

Subscribe to on-chain events with NDJSON streaming and optional SQLite persistence. Events are stored in `~/.vara-wallet/events.db` so they survive between runs.

```bash
vara-wallet subscribe blocks [--finalized]
vara-wallet subscribe messages <programId> [--type <Service/Event | EventName>] [--from-block <n>] [--idl <path>] [--pallet-event] [--no-decode]
vara-wallet subscribe mailbox <address>
vara-wallet subscribe balance <address>
vara-wallet subscribe transfers [--from <addr>] [--to <addr>]
vara-wallet subscribe program <programId>
```

**Global subscribe options:**
- `--count <n>` — exit after N events (useful for scripting)
- `--timeout <seconds>` — exit after N seconds
- `--no-persist` — stream only, skip SQLite persistence

`subscribe messages` shares the IDL-aware filtering and decoding behavior described under `watch` above. The filter flag is named `--type` here (vs `--event` on `watch`), but accepts the same values: Gear pallet event names, qualified `Service/Event`, or bare Sails event names. `--pallet-event` and `--no-decode` work the same way.

### `inbox`

Query captured mailbox messages from the event store.

```bash
vara-wallet inbox list [--since <duration>] [--limit <n>]
vara-wallet inbox read <messageId>
```

### `events`

Query and manage all captured events from the event store.

```bash
vara-wallet events list [--type <type>] [--since <duration>] [--program <id>] [--limit <n>]
vara-wallet events prune [--older-than <duration>]
```

### `watch`

Stream program events as NDJSON. For persistent event capture with SQLite storage, see `subscribe` above.

```bash
vara-wallet watch <programId> [--event <type>] [--idl <path>] [--pallet-event] [--no-decode]
```

`--event` accepts both Gear pallet event names (`UserMessageSent`, `MessageQueued`, ...) and Sails events as `Service/Event` or bare `Event` (when unambiguous across services). Pallet vocabulary resolves to the legacy pallet path first so existing scripts keep working; ambiguous bare Sails names fail fast with `AMBIGUOUS_EVENT` listing the alternatives.

When an IDL is loaded (explicit `--idl` or auto-resolved from the on-chain WASM), each emitted `UserMessageSent` is augmented with a decoded `sails: { service, event, data }` block alongside the existing raw fields (`payload`, `source`, `destination`, ...) — additive, so consumers parsing raw NDJSON keep working. Use `--pallet-event` to force pallet-event resolution even with an IDL loaded; `--no-decode` disables the opportunistic IDL auto-load entirely.

### `encode` / `decode`

```bash
vara-wallet encode <type> [value] [--args-file <path>] [--metadata <path>] [--idl <path>] [--program <id>] [--method <Service/Method>]
vara-wallet decode <type> <hex> [--metadata <path>] [--idl <path>] [--program <id>] [--method <Service/Method>]
```

For `encode`, the JSON value can be passed positionally or via `--args-file <path>` (use `-` for stdin). Positional and `--args-file` are mutually exclusive (`INVALID_ARGS_SOURCE`). Stdin via `--args-file -` rejects fast with `STDIN_IS_TTY` when no pipe is attached.

### `config`

Manage persistent CLI configuration. Settings are stored in `~/.vara-wallet/config.json`.

```bash
vara-wallet config list
vara-wallet config get <key>
vara-wallet config set <key> <value>
vara-wallet config set network testnet   # shorthand for wsEndpoint
```

Valid keys: `wsEndpoint`, `defaultAccount`, `dexFactoryAddress`, `faucetUrl`. The `network` alias maps `mainnet`/`testnet`/`local` to the corresponding `wsEndpoint` URL.

**Endpoint resolution order:** `--ws` flag > `--network` flag > `VARA_WS` env > `config.wsEndpoint` > default (`wss://rpc.vara.network`).

### `sign` / `verify`

Sign arbitrary data and verify signatures. Uses raw sr25519 signing (no `<Bytes>` wrapping). No network connection needed.

```bash
# Sign data (UTF-8 string by default)
vara-wallet sign "hello world"
# Output: { signature, publicKey, address, cryptoType }

# Sign hex data
vara-wallet sign 0xdeadbeef --hex

# Verify a signature
vara-wallet verify "hello world" 0x<signature> --address <signer-address>
# Output: { isValid, address, cryptoType }
```

The `--hex` flag treats input as 0x-prefixed hex bytes (strict validation: even-length, valid hex chars). Without `--hex`, input is treated as a UTF-8 string.

## File Structure

```
~/.vara-wallet/
  config.json          # wsEndpoint, defaultAccount, dexFactoryAddress, faucetUrl
  .passphrase          # Auto-generated or human-provided (0600)
  events.db            # SQLite event store (subscribe/inbox/events)
  wallets/
    default.json       # Encrypted keystore (0600)
    *.json
  idl-cache/
    <codeId>.cache.json  # Auto-populated from on-chain WASM or `idl import`
```

## Error Codes

| Code | Meaning |
|------|---------|
| `PASSPHRASE_REQUIRED` | Encrypted wallet, no passphrase available |
| `DECRYPT_FAILED` | Wrong passphrase |
| `WALLET_NOT_FOUND` | Wallet file doesn't exist |
| `WALLET_EXISTS` | Wallet name already taken |
| `NO_ACCOUNT` | No account configured |
| `TX_TIMEOUT` | Transaction not included in 60s |
| `TX_FAILED` | On-chain extrinsic failure |
| `IDL_NOT_FOUND` | No Sails IDL available |
| `METHOD_NOT_FOUND` | Method not in Sails IDL |
| `DEX_FACTORY_NOT_CONFIGURED` | No factory address set |
| `DEX_SERVICE_NOT_FOUND` | DEX method not found in IDL |
| `PAIR_NOT_FOUND` | Trading pair doesn't exist |
| `TOKEN_MISMATCH` | Tokens don't match pair |
| `INVALID_SLIPPAGE` | Slippage out of range (0-5000 bps) |
| `CONNECTION_TIMEOUT` | WebSocket or light client connection timed out (10s) |
| `CONNECTION_FAILED` | Network unreachable or request timed out |
| `WRONG_NETWORK` | Command not available on this network (e.g., faucet on mainnet) |
| `INVALID_NETWORK` | Unknown `--network` value |
| `INVALID_CONFIG_KEY` | Unknown config key passed to `config set/get` |
| `CONFLICTING_OPTIONS` | Mutually exclusive options used together (e.g., `--network` + `--ws`, `--estimate` + `--dry-run`) |
| `INVALID_ARGS_SOURCE` | `--args` and `--args-file` (or positional value + `--args-file` on `encode`) used together |
| `STDIN_IS_TTY` | `--args-file -` used with no pipe attached |
| `AMBIGUOUS_EVENT` | Bare Sails event name resolves to multiple services — qualify as `Service/Event` |
| `FAUCET_ERROR` | Faucet request failed |
| `PROGRAM_ERROR` | Sails program execution failed (panic/error) |
| `FAUCET_LIMIT` | Faucet daily/hourly limit reached |
| `RATE_LIMITED` | Too many requests (429) |
| `AUTH_ERROR` | Signature verification failed |

## Development

```bash
npm run build        # Bundle CLI with esbuild → dist/app.js
npm run dev          # Run from source via ts-node
npm test             # Run tests
npx tsc --noEmit     # Type check only
```

The published artifact is a single bundled file (`dist/app.js`) built by `scripts/build.mjs`. `better-sqlite3` and `smoldot` are kept external because they ship native binaries / WASM that cannot be inlined.

## License

MIT
