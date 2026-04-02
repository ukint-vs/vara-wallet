import { Command } from 'commander';
import { getApi } from '../../services/api';
import { initEventStore } from '../../services/event-store';
import { verbose, addressToHex } from '../../utils';
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

export function registerProgramCommand(parent: Command): void {
  parent
    .command('program')
    .description('Subscribe to program status changes')
    .argument('<programId>', 'program ID to watch (hex or SS58)')
    .action(async (programId: string) => {
      const opts = parent.parent!.optsWithGlobals() as { ws?: string; count?: string; timeout?: string; persist?: boolean };
      installGlobalTimeout(opts.timeout);
      const api = await getApi(opts.ws);
      const persist = opts.persist !== false;
      if (persist) initEventStore();
      installEpipeHandler();

      const programIdHex = addressToHex(programId);
      const counter = createEventCounter(opts.count ? parseInt(opts.count, 10) : undefined);

      verbose(`Subscribing to ProgramChanged for ${programIdHex}`);

      const subscribe = async () => {
        const unsub = await api.gearEvents.subscribeToGearEvent(
          'ProgramChanged',
          safeCallback((event) => {
            const { id: progId, change } = event.data;
            const id = progId.toHex();

            if (id !== programIdHex) return;

            const data = {
              type: 'program' as const,
              programId: id,
              status: change.toString(),
              timestamp: Date.now(),
            };

            emitAndPersist(data, persist, {
              type: 'program',
              event_id: id,
              data,
              program_id: id,
            });

            if (counter.increment()) {
              ka.triggerExit();
            }
          }),
        );
        return unsub;
      };

      const unsub = await withReconnect(api, subscribe);
      emitSystemEvent('subscribed', { subscription: 'program', programId: programIdHex });

      const ka = keepAlive([unsub], {
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
      });
      await ka.promise;
    });
}
