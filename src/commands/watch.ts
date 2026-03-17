import { Command } from 'commander';
import { getApi } from '../services/api';
import { outputNdjson, verbose, addressToHex } from '../utils';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Stream program events as NDJSON')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .option('--event <type>', 'event type to filter (UserMessageSent, MessageQueued, etc.)')
    .action(async (programId: string, options: { event?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const programIdHex = addressToHex(programId);
      verbose(`Watching events for program ${programIdHex}`);

      if (options.event) {
        // Subscribe to a specific event type
        await api.gearEvents.subscribeToGearEvent(
          options.event as 'UserMessageSent',
          (event) => {
            const data = event.data;
            outputNdjson({
              event: options.event,
              data: data.toJSON(),
              timestamp: Date.now(),
            });
          },
        );
      } else {
        // Default: subscribe to UserMessageSent filtered by source program
        await api.gearEvents.subscribeToUserMessageSentByActor(
          { from: programIdHex },
          (event) => {
            const data = event.data;
            outputNdjson({
              event: 'UserMessageSent',
              messageId: data.message.id.toHex(),
              source: data.message.source.toHex(),
              destination: data.message.destination.toHex(),
              payload: data.message.payload.toHex(),
              value: data.message.value.toString(),
              details: data.message.details.isSome
                ? {
                    replyTo: data.message.details.unwrap().to.toHex(),
                    code: data.message.details.unwrap().code.toString(),
                  }
                : null,
              timestamp: Date.now(),
            });
          },
        );
      }

      verbose('Streaming events... (Ctrl+C to stop)');

      // Keep process alive until interrupted
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => resolve());
        process.on('SIGTERM', () => resolve());
      });
    });
}
