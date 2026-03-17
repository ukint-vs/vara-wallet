#!/usr/bin/env node

import { Command } from 'commander';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { setOutputOptions, installGlobalErrorHandler, outputError } from './utils';
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
import { registerVftCommand } from './commands/vft';
import { registerVoucherCommand } from './commands/voucher';
import { registerEncodeCommand } from './commands/encode';
import { registerTxCommand } from './commands/tx';

installGlobalErrorHandler();

const program = new Command();

program
  .name('vara-wallet')
  .description('Agentic wallet CLI for Vara Network — designed for AI coding agents')
  .version('0.1.2')
  .option('--ws <endpoint>', 'WebSocket endpoint (default: wss://rpc.vara.network)')
  .option('--seed <seed>', 'account seed (SURI like //Alice or hex)')
  .option('--mnemonic <mnemonic>', 'account mnemonic phrase')
  .option('--account <name>', 'wallet name to use')
  .option('--json', 'force JSON output')
  .option('--human', 'force human-readable output')
  .option('--quiet', 'suppress all output except errors')
  .option('--verbose', 'show verbose debug info on stderr')
  .hook('preAction', () => {
    const opts = program.opts();
    setOutputOptions({
      json: opts.json,
      human: opts.human,
      quiet: opts.quiet,
      verbose: opts.verbose,
    });
  });

// Register commands — Phase 1
registerInitCommand(program);
registerWalletCommand(program);
registerBalanceCommand(program);
registerNodeCommand(program);

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
registerVftCommand(program);
registerVoucherCommand(program);
registerEncodeCommand(program);
registerTxCommand(program);

async function main(): Promise<void> {
  try {
    await cryptoWaitReady();
    await program.parseAsync(process.argv);
  } catch (error) {
    outputError(error);
    process.exitCode = 1;
  } finally {
    disconnectApi();
  }
}

main();
