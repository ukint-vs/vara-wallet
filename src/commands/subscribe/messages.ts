import { Command } from 'commander';
import { getApi } from '../../services/api';
import { initEventStore } from '../../services/event-store';
import { verbose, addressToHex } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  keepAlive,
  withReconnect,
  createEventCounter,
  validateEventName,
  validateFromBlock,
  formatUserMessageSent,
} from './shared';

export function registerMessagesCommand(parent: Command): void {
  parent
    .command('messages')
    .description('Subscribe to program messages and events')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .option('--type <eventType>', 'specific event type to subscribe to')
    .option('--from-block <number>', 'backfill from a specific block number')
    .action(async (programId: string, options: { type?: string; fromBlock?: string }) => {
      const opts = parent.parent!.optsWithGlobals() as { ws?: string; count?: string; timeout?: string; persist?: boolean };
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const programIdHex = addressToHex(programId);
      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      if (options.type) {
        // Subscribe to a specific event type
        const eventName = validateEventName(options.type);
        const fromBlock = options.fromBlock ? validateFromBlock(options.fromBlock) : undefined;

        verbose(`Subscribing to ${eventName} events for program ${programIdHex}`);

        const subscribe = async () => {
          const unsub = await api.gearEvents.subscribeToGearEvent(
            eventName,
            safeCallback((event) => {
              const eventData = event.data.toJSON();
              const data = {
                type: 'message' as const,
                event: eventName,
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
        emitSystemEvent('subscribed', { subscription: 'messages', programId: programIdHex, event: eventName });

        const ka = keepAlive([unsub], {
          timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        });
        await ka.promise;
      } else {
        // Default: subscribe to UserMessageSent from this program
        verbose(`Subscribing to UserMessageSent from ${programIdHex}`);

        const subscribe = async () => {
          const unsub = await api.gearEvents.subscribeToUserMessageSentByActor(
            { from: programIdHex },
            safeCallback((event) => {
              const msg = formatUserMessageSent(event);
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
