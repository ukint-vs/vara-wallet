import { Command } from 'commander';
import { getApi } from '../../services/api';
import { type AccountOptions } from '../../services/account';
import { initEventStore } from '../../services/event-store';
import { verbose, addressToHex, minimalToVara } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  keepAlive,
  withReconnect,
  createEventCounter,
} from './shared';

export function registerTransfersCommand(parent: Command): void {
  parent
    .command('transfers')
    .description('Subscribe to transfer events')
    .option('--from <address>', 'filter by sender address')
    .option('--to <address>', 'filter by recipient address')
    .action(async (options: { from?: string; to?: string }) => {
      const opts = parent.parent!.optsWithGlobals() as AccountOptions & { ws?: string; count?: string; timeout?: string; persist?: boolean };
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      const fromHex = options.from ? addressToHex(options.from) : undefined;
      const toHex = options.to ? addressToHex(options.to) : undefined;

      verbose(`Subscribing to transfers${fromHex ? ` from ${fromHex}` : ''}${toHex ? ` to ${toHex}` : ''}`);

      const subscribe = async () => {
        const unsub = await api.gearEvents.subscribeToTransferEvents(
          safeCallback(({ data: { from, to, amount } }) => {
            const fromAddr = from.toHex();
            const toAddr = to.toHex();

            // Client-side filtering
            if (fromHex && fromAddr !== fromHex) return;
            if (toHex && toAddr !== toHex) return;

            const data = {
              type: 'transfer' as const,
              from: fromAddr,
              to: toAddr,
              amount: minimalToVara(amount.toBigInt()),
              amountRaw: amount.toString(),
              timestamp: Date.now(),
            };

            emitAndPersist(data, persist, {
              type: 'transfer',
              data,
              source: fromAddr,
              destination: toAddr,
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
        subscription: 'transfers',
        ...(fromHex && { from: fromHex }),
        ...(toHex && { to: toHex }),
      });

      const ka = keepAlive([unsub], {
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
      await ka.promise;
    });
}
