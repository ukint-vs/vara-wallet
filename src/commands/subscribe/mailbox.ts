import { Command } from 'commander';
import { getApi } from '../../services/api';
import { resolveAddress, type AccountOptions } from '../../services/account';
import { initEventStore } from '../../services/event-store';
import { verbose } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  keepAlive,
  withReconnect,
  createEventCounter,
} from './shared';

export function registerMailboxCommand(parent: Command): void {
  parent
    .command('mailbox')
    .description('Subscribe to mailbox messages (received and read)')
    .argument('[address]', 'account address (defaults to configured account)')
    .action(async (address?: string) => {
      const opts = parent.parent!.optsWithGlobals() as AccountOptions & { ws?: string; count?: string; timeout?: string; persist?: boolean };
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const resolvedAddress = await resolveAddress(address, opts);
      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      verbose(`Subscribing to mailbox for ${resolvedAddress}`);

      const unsubscribers: Array<() => void> = [];

      // Subscription 1: UserMessageSent where destination === our address
      const subscribeReceived = async () => {
        const unsub = await api.gearEvents.subscribeToGearEvent(
          'UserMessageSent',
          safeCallback((event) => {
            const { message } = event.data;
            const dest = message.destination.toHex();

            if (dest !== resolvedAddress) return;

            const data = {
              type: 'mailbox' as const,
              action: 'received' as const,
              messageId: message.id.toHex(),
              source: message.source.toHex(),
              destination: dest,
              payload: message.payload.toHex(),
              value: message.value.toString(),
              timestamp: Date.now(),
            };

            emitAndPersist(data, persist, {
              type: 'mailbox',
              event_id: message.id.toHex(),
              data,
              source: message.source.toHex(),
              destination: dest,
            });

            if (counter.increment()) {
              ka.triggerExit();
            }
          }),
        );
        return unsub;
      };

      // Subscription 2: UserMessageRead (detect claims)
      const subscribeRead = async () => {
        const unsub = await api.gearEvents.subscribeToGearEvent(
          'UserMessageRead',
          safeCallback((event) => {
            const { id, reason } = event.data;
            const data = {
              type: 'mailbox' as const,
              action: 'read' as const,
              messageId: id.toHex(),
              reason: reason.toString(),
              timestamp: Date.now(),
            };

            emitAndPersist(data, persist, {
              type: 'mailbox',
              event_id: id.toHex(),
              data,
              destination: resolvedAddress,
            });
          }),
        );
        return unsub;
      };

      const unsub1 = await withReconnect(api, subscribeReceived);
      const unsub2 = await withReconnect(api, subscribeRead);
      unsubscribers.push(unsub1, unsub2);

      emitSystemEvent('subscribed', { subscription: 'mailbox', address: resolvedAddress });

      const ka = keepAlive(unsubscribers, {
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
      await ka.promise;
    });
}
