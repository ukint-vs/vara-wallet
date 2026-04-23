import { Command } from 'commander';
import { getApi } from '../../services/api';
import { initEventStore } from '../../services/event-store';
import { loadSailsAuto, type LoadedSails } from '../../services/sails';
import { verbose, addressToHex, errorMessage } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  installGlobalTimeout,
  keepAlive,
  withReconnect,
  createEventCounter,
  validateFromBlock,
  formatUserMessageSent,
  formatUserMessageSentMaybeDecoded,
  resolveSubscribeFilter,
} from './shared';

export function registerMessagesCommand(parent: Command): void {
  parent
    .command('messages')
    .description('Subscribe to program messages and events')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .option('--type <eventType>', 'specific event type (Gear pallet event or Sails Service/Event)')
    .option('--from-block <number>', 'backfill from a specific block number')
    .option('--idl <path>', 'path to local IDL file (forces Sails-aware decode)')
    .option('--pallet-event', 'force Gear pallet event resolution even when an IDL is loaded')
    .option('--no-decode', 'disable opportunistic IDL auto-load (raw output only)')
    .action(async (programId: string, options: {
      type?: string;
      fromBlock?: string;
      idl?: string;
      palletEvent?: boolean;
      decode?: boolean;
    }) => {
      const opts = parent.parent!.optsWithGlobals() as { ws?: string; count?: string; timeout?: string; persist?: boolean };
      installGlobalTimeout(opts.timeout);
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const programIdHex = addressToHex(programId);
      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      // Auto-load Sails opportunistically. Skip on --no-decode; otherwise
      // the loader handles --idl <path> first, then chain WASM, then
      // bundled fallbacks. Failures here are non-fatal unless the user
      // explicitly passed --idl. (Codex finding #3.)
      let sails: LoadedSails | null = null;
      const tryDecode = options.decode !== false;
      if (tryDecode) {
        try {
          sails = await loadSailsAuto(api, { programId, idl: options.idl });
          verbose(`Sails IDL loaded for ${programIdHex}`);
        } catch (err) {
          if (options.idl) throw err;
          verbose(`Sails auto-load skipped: ${errorMessage(err)}`);
        }
      }

      if (options.type) {
        const filter = resolveSubscribeFilter(options.type, sails, options.palletEvent === true);
        const fromBlock = options.fromBlock ? validateFromBlock(options.fromBlock) : undefined;

        if (filter.kind === 'pallet') {
          verbose(`Subscribing to ${filter.event} events for program ${programIdHex}`);

          const subscribe = async () => {
            const unsub = await api.gearEvents.subscribeToGearEvent(
              filter.event,
              safeCallback((event) => {
                const eventData = event.data.toJSON();
                const data = {
                  type: 'message' as const,
                  event: filter.event,
                  data: eventData,
                  programId: programIdHex,
                  timestamp: Date.now(),
                };

                emitAndPersist(data, persist, {
                  type: 'message',
                  data,
                  program_id: programIdHex,
                });

                if (counter.increment()) {
                  ka.triggerExit();
                }
              }),
              fromBlock,
            );
            return unsub;
          };

          const unsub = await withReconnect(api, subscribe);
          emitSystemEvent('subscribed', { subscription: 'messages', programId: programIdHex, event: filter.event });

          const ka = keepAlive([unsub], {
            timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
          });
          await ka.promise;
        } else {
          verbose(`Subscribing to Sails event ${filter.service}/${filter.event} for program ${programIdHex}`);

          const subscribe = async () => {
            const unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
              { from: programIdHex },
              safeCallback((event) => {
                const decoded = formatUserMessageSentMaybeDecoded(event, sails, programIdHex);
                const sailsBlock = (decoded as { sails?: { service: string; event: string } }).sails;
                if (!sailsBlock || sailsBlock.service !== filter.service || sailsBlock.event !== filter.event) {
                  return;
                }
                const data = {
                  type: 'message' as const,
                  event: 'UserMessageSent',
                  ...decoded,
                  timestamp: Date.now(),
                };

                emitAndPersist(data, persist, {
                  type: 'message',
                  event_id: decoded.messageId as string,
                  data,
                  source: decoded.source as string,
                  destination: decoded.destination as string,
                  program_id: programIdHex,
                });

                if (counter.increment()) {
                  ka.triggerExit();
                }
              }),
            );
            return unsub;
          };

          const unsub = await withReconnect(api, subscribe);
          emitSystemEvent('subscribed', {
            subscription: 'messages',
            programId: programIdHex,
            event: `${filter.service}/${filter.event}`,
          });

          const ka = keepAlive([unsub], {
            timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
          });
          await ka.promise;
        }
      } else {
        // Default: subscribe to UserMessageSent from this program
        verbose(`Subscribing to UserMessageSent from ${programIdHex}`);

        const subscribe = async () => {
          const unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
            { from: programIdHex },
            safeCallback((event) => {
              const msg = sails
                ? formatUserMessageSentMaybeDecoded(event, sails, programIdHex)
                : formatUserMessageSent(event);
              const data = {
                type: 'message' as const,
                event: 'UserMessageSent',
                ...msg,
                timestamp: Date.now(),
              };

              emitAndPersist(data, persist, {
                type: 'message',
                event_id: msg.messageId as string,
                data,
                source: msg.source as string,
                destination: msg.destination as string,
                program_id: programIdHex,
              });

              if (counter.increment()) {
                ka.triggerExit();
              }
            }),
          );
          return unsub;
        };

        const unsub = await withReconnect(api, subscribe);
        emitSystemEvent('subscribed', { subscription: 'messages', programId: programIdHex, event: 'UserMessageSent' });

        const ka = keepAlive([unsub], {
          timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        });
        await ka.promise;
      }
    });
}
