import { Command } from 'commander';
import { getApi } from '../../services/api';
import { resolveAddress, type AccountOptions } from '../../services/account';
import { initEventStore } from '../../services/event-store';
import { verbose, minimalToVara } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  keepAlive,
  withReconnect,
  createEventCounter,
} from './shared';

export function registerBalanceCommand(parent: Command): void {
  parent
    .command('balance')
    .description('Subscribe to account balance changes')
    .argument('[address]', 'account address (defaults to configured account)')
    .action(async (address?: string) => {
      const opts = parent.parent!.optsWithGlobals() as AccountOptions & { ws?: string; count?: string; timeout?: string; persist?: boolean };
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const resolvedAddress = await resolveAddress(address, opts);
      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      verbose(`Subscribing to balance changes for ${resolvedAddress}`);

      const subscribe = async () => {
        const unsub = await api.gearEvents.subscribeToBalanceChanges(
          resolvedAddress,
          safeCallback((balance) => {
            const data = {
              type: 'balance' as const,
              address: resolvedAddress,
              free: minimalToVara(balance.toBigInt()),
              freeRaw: balance.toString(),
              timestamp: Date.now(),
            };

            emitAndPersist(data, persist, {
              type: 'balance',
              data,
              destination: resolvedAddress,
            });

            if (counter.increment()) {
              ka.triggerExit();
            }
          }),
        );
        return unsub;
      };

      const unsub = await withReconnect(api, subscribe);
      emitSystemEvent('subscribed', { subscription: 'balance', address: resolvedAddress });

      const ka = keepAlive([unsub], {
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
      await ka.promise;
    });
}
