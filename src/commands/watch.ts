import { Command } from 'commander';
import { getApi } from '../services/api';
import { outputNdjson, verbose, addressToHex } from '../utils';
import { keepAlive, installEpipeHandler, formatUserMessageSent } from './subscribe/shared';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Stream program events as NDJSON')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .option('--event <type>', 'event type to filter (UserMessageSent, MessageQueued, etc.)')
    .action(async (programId: string, options: { event?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);
      installEpipeHandler();

      const programIdHex = addressToHex(programId);
      verbose(`Watching events for program ${programIdHex}`);

      let unsub: () => void;

      if (options.event) {
        // Subscribe to a specific event type
        unsub = await api.gearEvents.subscribeToGearEvent(
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
        unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
          { from: programIdHex },
          (event) => {
            outputNdjson({
              event: 'UserMessageSent',
              ...formatUserMessageSent(event),
              timestamp: Date.now(),
            });
          },
        );
      }

      verbose('Streaming events... (Ctrl+C to stop)');

      const ka = keepAlive([unsub]);
      await ka.promise;
    });
}
