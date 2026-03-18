import { Command } from 'commander';
import { initEventStore, queryMailbox, readEvent } from '../services/event-store';
import { output, CliError } from '../utils';
import { parseDuration } from './subscribe/shared';

export function registerInboxCommand(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Query captured mailbox messages from the event store');

  inbox
    .command('list')
    .description('List captured mailbox messages')
    .option('--since <duration>', 'time filter (e.g., 1h, 30m, 7d)')
    .option('--limit <n>', 'max results (default: 50)', '50')
    .action((options: { since?: string; limit: string }) => {
      initEventStore();

      const since = options.since ? Date.now() - parseDuration(options.since) : undefined;
      const limit = parseInt(options.limit, 10);

      const events = queryMailbox({ since, limit });
      const parsed = events.map((row) => ({
        id: row.id,
        ...JSON.parse(row.data),
        storedAt: row.created_at,
      }));

      output(parsed);
    });

  inbox
    .command('read')
    .description('Read a specific captured message by ID')
    .argument('<messageId>', 'message ID (hex)')
    .action((messageId: string) => {
      initEventStore();

      const event = readEvent(messageId);
      if (!event) {
        throw new CliError(`Message ${messageId} not found in event store`, 'NOT_FOUND');
      }

      output({
        id: event.id,
        ...JSON.parse(event.data),
        storedAt: event.created_at,
      });
    });
}
