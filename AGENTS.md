# AGENTS.md — Everything AI Agents Need to Know

This document is for AI coding agents that use `vara-wallet` to interact with Vara Network. It covers the blockchain concepts, the tool's architecture, and practical patterns for autonomous operation.

## What is Vara Network?

Vara is a blockchain for running programs (smart contracts) written in Rust and compiled to WASM. It's built on Substrate (same framework as Polkadot) and uses the Gear Protocol for program execution.

```
Substrate (blockchain framework)
  └── Gear Protocol (WASM program execution)
       └── Vara Network (production chain)
            ├── Mainnet: wss://rpc.vara.network
            └── Testnet: wss://testnet.vara.network
```

**Key concepts:**
- **Programs** = smart contracts (Rust → WASM, deployed on-chain)
- **Messages** = how you interact with programs (not function calls — async messages)
- **VARA** = native token (1 VARA = 10^12 minimal units, 12 decimals)
- **Gas** = computational resource for message processing
- **Mailbox** = inbox for messages addressed to your account

## What is Gear?

Gear is the execution engine. Programs run in isolated WASM sandboxes. Communication is message-based and asynchronous — you send a message, the program processes it, and may send a reply back to your mailbox.

## What is Sails?

Sails is a framework for writing Gear programs with a typed IDL (Interface Definition Language). Think of it like Solidity's ABI but for Gear programs. A Sails IDL defines:

- **Services** — logical groupings (like contracts)
- **Functions** — state-changing operations (require gas, produce transactions)
- **Queries** — read-only operations (free, no transaction)
- **Events** — emitted by programs during execution

Most modern Gear programs use Sails. The `call` and `discover` commands understand Sails IDL natively.

## What is @gear-js/api?

The TypeScript library that `vara-wallet` uses internally. It extends `@polkadot/api` with Gear-specific functionality: program management, message handling, gas calculation, state queries. You don't interact with it directly — `vara-wallet` wraps it.

## Getting Started (Zero Setup)

```bash
# Build
cd tools/vara-wallet && npm run build

# Create wallet — fully autonomous, no human needed
node dist/app.js wallet create --name agent
# Output: { address, name, encrypted: true, path }
# Auto-generates passphrase file at ~/.vara-wallet/.passphrase

# Check your address
node dist/app.js wallet list
```

The wallet is encrypted automatically. A random passphrase is generated and stored at `~/.vara-wallet/.passphrase` with `0600` permissions. You never see or handle the passphrase — it's read from the file transparently.

## Core Patterns

### Reading data (no account needed)

```bash
# Node info
vara-wallet node info

# Balance of any address
vara-wallet balance kGioe8b7bbEPbv1r1xbdmLbKJG9RvhUkN2VUBg9WLsNg33cp2

# Program info
vara-wallet program info 0x1234...

# Query a Sails program (read-only)
vara-wallet call 0x1234... Service/QueryMethod --args '[]'

# List programs on chain
vara-wallet program list --count 10
```

### Writing data (account required)

```bash
# Transfer VARA
vara-wallet --account agent transfer <destination> 10

# Send message to any actor (program, user, wallet)
vara-wallet --account agent message send 0x1234... --payload 0xdeadbeef

# Send message with value transfer (transfers VARA to any destination alongside the message)
vara-wallet --account agent message send 0x1234... --payload 0xdeadbeef --value 5

# Call a Sails function (state-changing)
vara-wallet --account agent call 0x1234... Service/Function --args '["arg1"]'

# Upload a program (raw payload)
vara-wallet --account agent program upload ./my_program.opt.wasm --payload 0x00

# Upload a program with IDL-based constructor encoding
vara-wallet --account agent program upload ./my_program.opt.wasm --idl ./program.idl --args '["MyToken", "MTK", 18]'
```

### Signing and verifying data

Sign arbitrary data for proof-of-ownership or challenge-response flows. No network needed.

```bash
# Sign a challenge string
RESULT=$(vara-wallet --account agent sign "challenge-from-faucet-api")
SIGNATURE=$(echo $RESULT | jq -r .signature)

# Verify a signature
vara-wallet verify "challenge-from-faucet-api" $SIGNATURE --address kGioe8b7...
# Output: { isValid: true, address: "0x...", cryptoType: "sr25519" }

# Sign hex data
vara-wallet --account agent sign 0xdeadbeef --hex
```

Uses raw sr25519 signing (no `<Bytes>` wrapping — different from Polkadot browser extension convention).

### Extracting private keys

Three ways to get key material from a wallet:

```bash
# 1. At creation time — show mnemonic and seed (only chance to see mnemonic)
vara-wallet wallet create --name my-key --show-secret
# Output: { address, name, mnemonic, seed, ... }

# 2. Export raw keys from an existing wallet
vara-wallet wallet keys my-key
# Output: { address, publicKey, secretKeyPkcs8, type }

# 3. Export decrypted JSON keystore (Polkadot-compatible format)
vara-wallet wallet export my-key --decrypt
# Output: full JSON keystore with unencrypted encoded field
```

**`wallet keys`** is the most direct method — it outputs the PKCS8-encoded secret key as hex. This blob contains the full keypair and can be used with Polkadot tooling (`@polkadot/keyring`) to reconstruct the pair.

**Important:** The mnemonic is only available at `wallet create --show-secret` time. It is not stored in the wallet file. If you need the mnemonic for backup or cross-wallet recovery, capture it at creation.

### Discovering program interfaces

Before calling a program, discover its interface:

```bash
vara-wallet discover 0x1234... --idl ./program.idl
# Returns: all services, functions, queries, events with argument types
```

If the program's IDL is registered in meta-storage, you can omit `--idl`:

```bash
export VARA_META_STORAGE=https://idea.gear-tech.io/api
vara-wallet discover 0x1234...
```

### Gas handling

Gas is auto-calculated when you omit `--gas-limit`. The CLI calls `calculateGas.handle()` or `calculateGas.initUpload()` and uses the minimum gas limit returned. You almost never need to specify gas manually.

```bash
# Auto gas (recommended)
vara-wallet --account agent message send 0x1234... --payload 0x00

# Manual gas (override)
vara-wallet --account agent message send 0x1234... --payload 0x00 --gas-limit 50000000000
```

### Waiting for replies

Messages are async. After sending, wait for the reply:

```bash
# Send and capture messageId
RESULT=$(vara-wallet --account agent message send 0x1234... --payload 0x00)
MSG_ID=$(echo $RESULT | jq -r .messageId)

# Wait for reply (30s default timeout)
vara-wallet wait $MSG_ID --timeout 60
# Returns: { payload, value, replyCode, ... }
```

### Streaming events

Watch a program's events in real-time:

```bash
vara-wallet watch 0x1234...
# Streams NDJSON: one JSON object per line per event
```

### Subscribing to events (with persistence)

`subscribe` streams events like `watch`, but also saves them to a local SQLite database (`~/.vara-wallet/events.db`). This means you can query events between runs — critical for mailbox messages that disappear after ~1 block.

```bash
# Watch for mailbox messages (they vanish after 1 block — subscribe catches them)
vara-wallet subscribe mailbox kGioe8b7...

# Wait for exactly 1 transfer event, then exit
vara-wallet subscribe transfers --count 1 --timeout 30

# Stream new blocks
vara-wallet subscribe blocks --finalized

# Query captured events later
vara-wallet inbox list --since 1h
vara-wallet events list --type mailbox --limit 10
```

### VFT (Fungible Token) operations

```bash
# Check token balance
vara-wallet vft balance 0xTokenProgram... --idl ./vft.idl

# Transfer tokens
vara-wallet --account agent vft transfer 0xTokenProgram... <to> 1000 --idl ./vft.idl

# Approve spender
vara-wallet --account agent vft approve 0xTokenProgram... <spender> 1000 --idl ./vft.idl
```

### DEX (Decentralized Exchange) operations

Trade tokens on the vara-amm DEX. Requires a factory address — set via `--factory`, `VARA_DEX_FACTORY` env, or `dexFactoryAddress` in config.

```bash
# Query available pairs
vara-wallet dex pairs --factory 0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e

# Get a swap quote (check price impact before trading)
vara-wallet dex quote 0xTOKEN_IN 0xTOKEN_OUT 1000000 --factory 0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e

# Execute a swap (auto-approves the input token)
vara-wallet --account agent dex swap 0xTOKEN_IN 0xTOKEN_OUT 1000000 --factory 0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e --slippage 100

# Add liquidity
vara-wallet --account agent dex add-liquidity 0xTOKEN0 0xTOKEN1 1000000 1000000 --factory 0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e

# Remove liquidity (amount is LP tokens)
vara-wallet --account agent dex remove-liquidity 0xTOKEN0 0xTOKEN1 5000 --factory 0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e
```

Slippage is in basis points (100 = 1%). Tokens are auto-sorted to match factory convention. Use `--units token` for human-readable amounts.

### Generic substrate operations

For anything not covered by specific commands:

```bash
# Submit any extrinsic
vara-wallet --account agent tx system remark '"hello"'

# Query any storage
vara-wallet query system account '"0x1234..."'
vara-wallet query balances totalIssuance
```

## Output Format

All commands output JSON to stdout. Errors go to stderr as JSON with `{ error, code }`.

```bash
# Parse with jq
vara-wallet balance | jq .balance

# Capture structured output
RESULT=$(vara-wallet --account agent transfer <to> 1)
TX_HASH=$(echo $RESULT | jq -r .txHash)
```

Use `--verbose` for debug info (goes to stderr, won't interfere with JSON parsing):

```bash
vara-wallet --verbose --account agent transfer <to> 1 2>/dev/null | jq .
```

## Wallet Security Model

```
Threat: Observer watching agent's terminal
Solution: Secrets never appear in CLI args, env vars, or output

~/.vara-wallet/
  .passphrase     ← 0600, auto-generated, agent never reads/prints this
  wallets/
    agent.json    ← encrypted with passphrase (xsalsa20-poly1305 + scrypt)

Flow:
  1. wallet create → reads passphrase from file (or generates it)
  2. wallet create → encrypts keyring JSON with passphrase
  3. Any command using --account → reads passphrase from file → decrypts wallet
  4. Signs transaction → submits → done

  At no point does the passphrase or private key appear in terminal output.
```

**Passphrase resolution chain:**
1. `~/.vara-wallet/.passphrase` file (primary)
2. `VARA_PASSPHRASE` env var (CI/Docker fallback)

## Amounts and Units

VARA uses 10 decimal places. By default, amounts are in VARA:

```bash
vara-wallet transfer <to> 1.5          # 1.5 VARA
vara-wallet transfer <to> 1500000000 --units raw   # same amount in raw units
```

The existential deposit (minimum balance) is typically 10 VARA on mainnet.

### Draining an account

```bash
vara-wallet transfer <to> --all        # sends full balance, closes the sender's account
```

`--all` uses Substrate's native `transferAll` extrinsic with `keepAlive=false`, so there's no client-side fee/ED math to get wrong. The source account is reaped after the call. Regular transfers (without `--all`) use `transferKeepAlive` and leave at least the existential deposit behind. `--all` and an explicit amount are mutually exclusive.

## Error Handling

Every error returns `{ error: "message", code: "ERROR_CODE" }` on stderr.

**Common errors and what to do:**

| Code | Meaning | Action |
|------|---------|--------|
| `PASSPHRASE_REQUIRED` | Encrypted wallet, no passphrase | Ensure `~/.vara-wallet/.passphrase` exists |
| `DECRYPT_FAILED` | Wrong passphrase | Check passphrase file content |
| `NO_ACCOUNT` | No signing account | Add `--account <name>` or `--seed` |
| `TX_TIMEOUT` | Transaction didn't land in 60s | Retry — network may be congested |
| `TX_FAILED` | On-chain failure | Check events in output for details |
| `IDL_NOT_FOUND` | No Sails IDL for program | Provide `--idl <path>` or set `VARA_META_STORAGE` |
| `PROGRAM_ERROR` | Program panicked/failed | Check error message for program-side issue |

## Addresses

Vara uses SS58 addresses (like `kGioe8b7...`). Program IDs and message IDs are hex (`0x1234...`).

- **Account address:** SS58 format, starts with `k` on Vara
- **Program ID:** 0x-prefixed 64-char hex (H256)
- **Message ID:** 0x-prefixed 64-char hex (H256)
- **Code ID:** 0x-prefixed 64-char hex (H256)
- **Block hash:** 0x-prefixed 64-char hex (H256)

## Networks

| Network | Endpoint | Explorer |
|---------|----------|----------|
| Mainnet | `wss://rpc.vara.network` (default) | `--network mainnet` | https://vara.subscan.io |
| Testnet | `wss://testnet.vara.network` | `--network testnet` | https://vara-testnet.subscan.io |
| Local | `ws://localhost:9944` | `--network local` | — |

**Testnet DEX (Rivr):** Factory address `0xaec14c514124fffa6c4b832ba7c12fa19e7fa663774c549c114786e220dd0a4e`

Switch networks:

```bash
# Shorthand (recommended)
vara-wallet --network testnet balance

# Full URL
vara-wallet --ws wss://testnet.vara.network balance

# Persist across sessions
vara-wallet config set network testnet
```

Or set globally for the current shell session:

```bash
export VARA_WS=wss://testnet.vara.network
```

**Resolution order:** `--ws` > `--network` > `VARA_WS` env > `config.wsEndpoint` > default.

### Light Client Mode

Use `--light` to connect via an embedded smoldot light client instead of a WebSocket RPC. This provides trustless, decentralized chain access without depending on centralized RPC infrastructure.

```bash
vara-wallet --light balance
vara-wallet --light node info
```

Or via environment variable:

```bash
export VARA_LIGHT=1
vara-wallet balance
```

**Note:** Initial sync takes 10-30s. Gear-specific RPC methods (gas calculation) are not available through the light client, so commands like `message send` require manual `--gas-limit`.

## Common Workflows

### Deploy and interact with a program

```bash
# 1. Upload WASM with IDL-based constructor encoding (auto-selects constructor)
UPLOAD=$(vara-wallet --account agent program upload ./my_program.opt.wasm --idl ./my_program.idl --args '["MyToken", "MTK", 18]')
PROGRAM_ID=$(echo $UPLOAD | jq -r .programId)

# 2. Discover its interface
vara-wallet discover $PROGRAM_ID --idl ./my_program.idl

# 3. Call a function
vara-wallet --account agent call $PROGRAM_ID MyService/DoSomething --args '["hello"]' --idl ./my_program.idl

# 4. Query state
vara-wallet call $PROGRAM_ID MyService/GetState --args '[]' --idl ./my_program.idl
```

### Monitor a program

```bash
# Stream events (NDJSON)
vara-wallet watch $PROGRAM_ID | while read -r line; do
  echo "$line" | jq .
done
```

### Manage multiple wallets

```bash
vara-wallet wallet create --name deployer
vara-wallet wallet create --name operator
vara-wallet wallet default deployer

# Use specific wallet
vara-wallet --account operator transfer <to> 5
```

### Check transaction result

Every write command returns events. Check for success:

```bash
RESULT=$(vara-wallet --account agent transfer <to> 1)
# Check if transfer succeeded
echo $RESULT | jq '.events[] | select(.section == "balances" and .method == "Transfer")'
```

## Idiosyncrasies

1. **Messages are async.** `message send` returns when the message is queued, not when it's processed. Use `wait` to get the reply.

8. **`message send` doubles as a value transfer.** The destination can be any actor — program, user account, or wallet. Use `--value` to send VARA tokens alongside a message payload. This is useful for payable interactions or transferring tokens with custom data to any address.

2. **Gas = 0 fallback.** If gas calculation returns 0 (can happen with some programs), the CLI falls back to the block gas limit.

3. **Sails queries vs functions.** `call` auto-detects whether a method is a query (read-only, free) or function (state-changing, needs gas). You don't need to specify.

4. **IDL resolution.** The `call`, `discover`, and `vft` commands need a Sails IDL. Provide `--idl <path>` or set `VARA_META_STORAGE` for remote fetch by program codeId.

5. **Hex strings for byte arrays.** When a Sails method expects `vec u8` or `[u8; N]`, you can pass hex strings like `"0xabcdef..."` in `--args` and they'll be auto-converted to byte arrays. No need to manually convert hex to number arrays.

6. **NDJSON for streaming.** The `watch` command outputs one JSON object per line (newline-delimited JSON), not a JSON array.

7. **Wallet encryption is default.** `wallet create` always encrypts unless `--no-encrypt` is passed. Secrets (mnemonic, seed) are suppressed unless `--show-secret` is passed.

8. **File permissions matter.** Wallet files are `0600`, passphrase file is `0600`, wallets directory is `0700`. The CLI enforces this.
