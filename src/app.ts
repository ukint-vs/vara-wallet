#!/usr/bin/env node

import { Command } from 'commander';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { setOutputOptions, installGlobalErrorHandler, outputError, CliError, enableTiming, markStage, markTotal, fastExit } from './utils';
import { disconnectApi } from './services/api';
import { registerInitCommand } from './commands/init';
import { registerWalletCommand } from './commands/wallet';
import { registerBalanceCommand } from './commands/balance';
import { registerNodeCommand } from './commands/node';
import { registerMessageCommand } from './commands/message';
import { registerMailboxCommand } from './commands/mailbox';
import { registerProgramCommand } from './commands/program';
import { registerCodeCommand } from './commands/code';
import { registerStateCommand } from './commands/state';
import { registerWaitCommand } from './commands/wait';
import { registerWatchCommand } from './commands/watch';
import { registerDiscoverCommand } from './commands/discover';
import { registerCallCommand } from './commands/call';
import { registerIdlCommand } from './commands/idl';
import { registerMetadataCommand } from './commands/metadata';
import { registerVftCommand } from './commands/vft';
import { registerVoucherCommand } from './commands/voucher';
import { registerEncodeCommand } from './commands/encode';
import { registerSignCommand } from './commands/sign';
import { registerTxCommand } from './commands/tx';
import { registerSubscribeCommand } from './commands/subscribe';
import { registerInboxCommand } from './commands/inbox';
import { registerEventsCommand } from './commands/events';
import { registerDexCommand } from './commands/dex';
import { registerFaucetCommand } from './commands/faucet';
import { registerConfigCommand, NETWORK_MAP } from './commands/config-cmd';

installGlobalErrorHandler();

const VERSION = process.env.VARA_WALLET_VERSION ?? '0.0.0-dev';

const program = new Command();

program
  .name('vara-wallet')
  .description('Agentic wallet CLI for Vara Network — designed for AI coding agents')
  .version(VERSION)
  .option('--ws <endpoint>', 'WebSocket endpoint (default: wss://rpc.vara.network)')
  .option('--light', 'use embedded light client (smoldot) instead of WebSocket')
  .option('--seed <seed>', 'account seed (SURI like //Alice or hex)')
  .option('--mnemonic <mnemonic>', 'account mnemonic phrase')
  .option('--account <name>', 'wallet name to use')
  .option('--json', 'force JSON output')
  .option('--human', 'force human-readable output')
  .option('--quiet', 'suppress all output except errors')
  .option('--verbose', 'show verbose debug info on stderr')
  .option('--network <name>', 'network shorthand: mainnet, testnet, or local')
  .option('--timing', 'emit per-stage timing NDJSON to stderr (no-op without flag)')
  .hook('preAction', () => {
    const opts = program.opts();
    setOutputOptions({
      json: opts.json,
      human: opts.human,
      quiet: opts.quiet,
      verbose: opts.verbose,
    });
    if (opts.timing) {
      enableTiming();
    }
    if (opts.light) {
      process.env.VARA_LIGHT = '1';
    }
    if (opts.network) {
      if (opts.ws) {
        throw new CliError('Cannot use both --network and --ws', 'CONFLICTING_OPTIONS');
      }
      const url = NETWORK_MAP[opts.network];
      if (!url) {
        throw new CliError(
          `Unknown network "${opts.network}". Valid: ${Object.keys(NETWORK_MAP).join(', ')}`,
          'INVALID_NETWORK',
        );
      }
      process.env.VARA_WS = url;
    }
  });

// Register commands — Phase 1
registerInitCommand(program);
registerWalletCommand(program);
registerBalanceCommand(program);
registerNodeCommand(program);
registerFaucetCommand(program);
registerConfigCommand(program);

// Register commands — Phase 2
registerMessageCommand(program);
registerMailboxCommand(program);
registerProgramCommand(program);
registerCodeCommand(program);
registerStateCommand(program);
registerWaitCommand(program);
registerWatchCommand(program);

// Register commands — Phase 3
registerDiscoverCommand(program);
registerCallCommand(program);
registerIdlCommand(program);
registerMetadataCommand(program);
registerVftCommand(program);
registerVoucherCommand(program);
registerEncodeCommand(program);
registerSignCommand(program);
registerTxCommand(program);

// Register commands — Phase 4: Subscriptions & Event Store
registerSubscribeCommand(program);
registerInboxCommand(program);
registerEventsCommand(program);

// Register commands — Phase 5: DEX
registerDexCommand(program);

// Graceful shutdown (moved from api.ts so subscribe/keepAlive can override).
// Subscribe commands don't go through main()'s finally: they await
// keepAlive(...) which only resolves on signal/timeout, and keepAlive's
// own cleanup runs disconnectApi() before the action returns. By the
// time main() reaches finally, the WS is already torn down by them.
process.on('SIGINT', () => {
  disconnectApi();
  fastExit(0);
});
process.on('SIGTERM', () => {
  disconnectApi();
  fastExit(0);
});

async function main(): Promise<void> {
  try {
    await cryptoWaitReady();
    await program.parseAsync(process.argv);
  } catch (error) {
    outputError(error);
    process.exitCode = 1;
  } finally {
    disconnectApi();
    markStage('shutdown');
    markTotal();
    fastExit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  }
}

main();
