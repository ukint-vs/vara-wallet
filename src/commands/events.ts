import { Command } from 'commander';
import { initEventStore, queryEvents, pruneEvents } from '../services/event-store';
import { output, addressToHex } from '../utils';
import { parseDuration } from './subscribe/shared';

export function registerEventsCommand(program: Command): void {
  const events = program
    .command('events')
    .description('Query and manage captured events from the event store');

  events
    .command('list')
    .description('List captured events with optional filters')
    .option('--type <type>', 'filter by event type (block, message, mailbox, balance, transfer, program)')
    .option('--since <duration>', 'time filter (e.g., 1h, 30m, 7d)')
    .option('--program <id>', 'filter by program ID')
    .option('--limit <n>', 'max results (default: 50)', '50')
    .action((options: { type?: string; since?: string; program?: string; limit: string }) => {
      initEventStore();

      const since = options.since ? Date.now() - parseDuration(options.since) : undefined;
      const limit = parseInt(options.limit, 10);
      const program = options.program ? addressToHex(options.program) : undefined;

      const rows = queryEvents({ type: options.type, since, program, limit });
      const parsed = rows.map((row) => ({
        id: row.id,
        ...JSON.parse(row.data),
        storedAt: row.created_at,
      }));

      output(parsed);
    });

  events
    .command('prune')
    .description('Delete old events from the event store')
    .option('--older-than <duration>', 'delete events older than duration (default: 7d)', '7d')
    .action((options: { olderThan: string }) => {
      initEventStore();

      const olderThanMs = parseDuration(options.olderThan);
      const count = pruneEvents(olderThanMs);

      output({ pruned: count });
    });
}
