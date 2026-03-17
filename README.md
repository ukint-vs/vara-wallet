# vara-wallet

Agentic wallet CLI for Vara Network — designed for AI coding agents.

All output is structured JSON by default. No interactive prompts. Wallets are encrypted automatically with zero setup required.

## Quick Start

```bash
# Install
cd tools/vara-wallet && npm run build

# Create a wallet (auto-generates passphrase, encrypts, no secrets shown)
vara-wallet wallet create --name my-wallet

# Check balance
vara-wallet balance

# Transfer VARA
vara-wallet transfer <destination> 10

# Interact with a Sails program
vara-wallet call <programId> Service/Method --args '["arg1", "arg2"]'
```

## Installation

```bash
npm run build
# Binary: dist/app.js
# Or link globally: npm link
```

## Global Options

```
--ws <endpoint>       WebSocket endpoint (default: wss://rpc.vara.network)
--seed <seed>         Account seed (SURI like //Alice or hex)
--mnemonic <mnemonic> Account mnemonic phrase
--account <name>      Wallet name to use
--json                Force JSON output
--human               Force human-readable output
--quiet               Suppress all output except errors
--verbose             Show debug info on stderr
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VARA_WS` | WebSocket endpoint | `wss://rpc.vara.network` |
| `VARA_SEED` | Account seed | — |
| `VARA_MNEMONIC` | Account mnemonic | — |
| `VARA_PASSPHRASE` | Wallet passphrase (CI/Docker fallback) | — |
| `VARA_WALLET_DIR` | Config directory | `~/.vara-wallet` |
| `VARA_META_STORAGE` | Meta-storage URL for IDL fetching | — |

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

### `wallet`

```bash
vara-wallet wallet create [--name <n>] [--passphrase <p>] [--no-encrypt] [--show-secret]
vara-wallet wallet import [--name <n>] [--mnemonic <m>] [--seed <s>] [--json <path>] [--passphrase <p>] [--no-encrypt]
vara-wallet wallet list
vara-wallet wallet export <name> [--decrypt]
vara-wallet wallet default [name]
```

### `balance` / `transfer`

```bash
vara-wallet balance [address]
vara-wallet transfer <to> <amount> [--units vara|raw]
```

### `message`

```bash
vara-wallet message send <programId> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--metadata <path>]
vara-wallet message reply <messageId> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--units vara|raw] [--metadata <path>]
vara-wallet message calculate-reply <programId> [--payload <hex>] [--value <v>] [--units vara|raw] [--origin <addr>] [--at <blockHash>]
```

Gas is auto-calculated if `--gas-limit` is omitted.

### `program`

```bash
vara-wallet program upload <wasm> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--salt <hex>] [--metadata <path>]
vara-wallet program deploy <codeId> [--payload <hex>] [--gas-limit <n>] [--value <v>] [--salt <hex>] [--metadata <path>]
vara-wallet program info <programId>
vara-wallet program list [--count <n>]
```

### `code`

```bash
vara-wallet code upload <wasm>
vara-wallet code info <codeId>
vara-wallet code list [--count <n>]
```

### `call` (Sails)

High-level method invocation on Sails programs. Auto-detects queries vs functions.

```bash
vara-wallet call <programId> <Service/Method> [--args <json>] [--value <v>] [--gas-limit <n>] [--idl <path>]
```

### `discover` (Sails)

Introspect a Sails program's services, functions, queries, and events.

```bash
vara-wallet discover <programId> [--idl <path>]
```

### `vft` (Fungible Tokens)

```bash
vara-wallet vft balance <tokenProgram> [account] [--idl <path>]
vara-wallet vft transfer <tokenProgram> <to> <amount> [--idl <path>]
vara-wallet vft approve <tokenProgram> <spender> <amount> [--idl <path>]
```

### `voucher`

```bash
vara-wallet voucher issue <spender> <value> [--units vara|raw] [--duration <blocks>] [--programs <ids>]
vara-wallet voucher list <account> [--program <id>]
vara-wallet voucher revoke <spender> <voucherId>
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

### `watch`

Stream program events as NDJSON.

```bash
vara-wallet watch <programId> [--event <type>]
```

### `encode` / `decode`

```bash
vara-wallet encode <type> <value> [--metadata <path>] [--idl <path>] [--program <id>] [--method <Service/Method>]
vara-wallet decode <type> <hex> [--metadata <path>] [--idl <path>] [--program <id>] [--method <Service/Method>]
```

## File Structure

```
~/.vara-wallet/
  config.json          # wsEndpoint, defaultAccount, metaStorageUrl
  .passphrase          # Auto-generated or human-provided (0600)
  wallets/
    default.json       # Encrypted keystore (0600)
    *.json
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

## Development

```bash
npm run build        # Compile TypeScript
npm test             # Run tests
npx tsc --noEmit     # Type check only
```

## License

GPL-3.0
