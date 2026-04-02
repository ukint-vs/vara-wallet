import { Command } from 'commander';
import { getApi } from '../../services/api';
import { initEventStore } from '../../services/event-store';
import { verbose } from '../../utils';
import {
  emitSystemEvent,
  emitAndPersist,
  safeCallback,
  installEpipeHandler,
  installGlobalTimeout,
  keepAlive,
  withReconnect,
  createEventCounter,
} from './shared';

export function registerBlocksCommand(parent: Command): void {
  parent
    .command('blocks')
    .description('Subscribe to new block headers')
    .option('--finalized', 'subscribe to finalized blocks only')
    .action(async (options: { finalized?: boolean }) => {
      const opts = parent.parent!.optsWithGlobals() as { ws?: string; count?: string; timeout?: string; persist?: boolean };
      installGlobalTimeout(opts.timeout);
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);
      const mode = options.finalized ? 'finalized' : 'latest';
      verbose(`Subscribing to ${mode} blocks`);

      const subscribe = async () => {
        const method = options.finalized
          ? api.rpc.chain.subscribeFinalizedHeads.bind(api.rpc.chain)
          : api.rpc.chain.subscribeNewHeads.bind(api.rpc.chain);

        const unsub = await method(safeCallback((header) => {
          const data = {
            type: 'block' as const,
            number: header.number.toNumber(),
            hash: header.hash.toHex(),
            parentHash: header.parentHash.toHex(),
            stateRoot: header.stateRoot.toHex(),
            extrinsicsRoot: header.extrinsicsRoot.toHex(),
            timestamp: Date.now(),
          };

          emitAndPersist(data, persist, {
            type: 'block',
            event_id: header.hash.toHex(),
            data,
            block_number: header.number.toNumber(),
            block_hash: header.hash.toHex(),
          });

          if (counter.increment()) {
            ka.triggerExit();
          }
        }));

        return unsub;
      };

      const unsub = await withReconnect(api, subscribe);
      emitSystemEvent('subscribed', { subscription: 'blocks', mode });

      const ka = keepAlive([unsub], {
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
      await ka.promise;
    });
}
