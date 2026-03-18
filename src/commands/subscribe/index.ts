import { Command } from 'commander';
import { registerBlocksCommand } from './blocks';
import { registerMessagesCommand } from './messages';
import { registerMailboxCommand } from './mailbox';
import { registerBalanceCommand } from './balance';
import { registerTransfersCommand } from './transfers';
import { registerProgramCommand } from './program';

export function registerSubscribeCommand(program: Command): void {
  const subscribe = program
    .command('subscribe')
    .description('Subscribe to on-chain events (streams NDJSON, persists to SQLite)')
    .option('--count <n>', 'exit after N events')
    .option('--timeout <seconds>', 'exit after N seconds')
    .option('--no-persist', 'stream only, skip SQLite persistence');

  registerBlocksCommand(subscribe);
  registerMessagesCommand(subscribe);
  registerMailboxCommand(subscribe);
  registerBalanceCommand(subscribe);
  registerTransfersCommand(subscribe);
  registerProgramCommand(subscribe);
}
