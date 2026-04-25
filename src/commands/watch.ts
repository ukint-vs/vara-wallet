import { Command } from 'commander';
import { getApi } from '../services/api';
import { loadSailsAuto, type LoadedSails } from '../services/sails';
import { outputNdjson, verbose, addressToHex, errorMessage } from '../utils';
import {
  keepAlive,
  installEpipeHandler,
  formatUserMessageSent,
  formatUserMessageSentMaybeDecoded,
  resolveSubscribeFilter,
} from './subscribe/shared';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Stream program events as NDJSON')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .option('--event <type>', 'event filter: Gear pallet name (UserMessageSent), Sails Service/Event, bare Sails event, or pallet:Name to force pallet vocab')
    .option('--idl <path>', 'path to local IDL file (forces Sails-aware decode)')
    .option('--no-decode', 'disable opportunistic IDL auto-load (raw output only)')
    .action(async (programId: string, options: {
      event?: string;
      idl?: string;
      decode?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);
      installEpipeHandler();

      const programIdHex = addressToHex(programId);
      verbose(`Watching events for program ${programIdHex}`);

      // Auto-load Sails opportunistically when programId is given. `loadSailsAuto`
      // already handles `--idl <path>` first and falls back to chain WASM /
      // bundled IDLs. Failures here are non-fatal: --no-decode disables the
      // attempt entirely; otherwise we silently fall back to raw output and
      // log via `verbose`. (Codex finding #3.)
      let sails: LoadedSails | null = null;
      const tryDecode = options.decode !== false;
      if (tryDecode) {
        try {
          sails = await loadSailsAuto(api, { programId, idl: options.idl });
          verbose(`Sails IDL loaded for ${programIdHex}`);
        } catch (err) {
          // Re-throw when the user explicitly passed --idl <path> and it
          // failed to read/parse — silent fallback would mask a config bug.
          if (options.idl) throw err;
          verbose(`Sails auto-load skipped: ${errorMessage(err)}`);
        }
      }

      let unsub: () => void;

      if (options.event) {
        const filter = resolveSubscribeFilter(options.event, sails);

        if (filter.kind === 'pallet') {
          // Pallet event path — back-compat with the original behavior.
          unsub = await api.gearEvents.subscribeToGearEvent(
            filter.event as 'UserMessageSent',
            (event) => {
              if (filter.event === 'UserMessageSent') {
                outputNdjson({
                  event: 'UserMessageSent',
                  ...formatUserMessageSentMaybeDecoded(event, sails, programIdHex),
                  timestamp: Date.now(),
                });
              } else {
                outputNdjson({
                  event: filter.event,
                  data: event.data.toJSON(),
                  timestamp: Date.now(),
                });
              }
            },
          );
        } else {
          // Sails event path — only `UserMessageSent` carries Sails event payloads.
          unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
            { from: programIdHex },
            (event) => {
              const formatted = formatUserMessageSentMaybeDecoded(event, sails, programIdHex);
              const decodedBlock = (formatted as {
                decoded?: { kind: string; service: string; event: string };
              }).decoded;
              if (
                !decodedBlock ||
                decodedBlock.kind !== 'sails' ||
                decodedBlock.service !== filter.service ||
                decodedBlock.event !== filter.event
              ) {
                return;
              }
              outputNdjson({ event: 'UserMessageSent', ...formatted, timestamp: Date.now() });
            },
          );
        }
      } else {
        // Default: subscribe to UserMessageSent filtered by source program
        unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
          { from: programIdHex },
          (event) => {
            const base = sails
              ? formatUserMessageSentMaybeDecoded(event, sails, programIdHex)
              : formatUserMessageSent(event);
            outputNdjson({
              event: 'UserMessageSent',
              ...base,
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
