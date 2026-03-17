import { GearApi } from '@gear-js/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { CliError, verbose } from '../utils';

// Use a relaxed type to avoid #private field conflicts between @polkadot versions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyExtrinsic = { signAndSend: (...args: any[]) => any; hash: { toHex(): string } };

export interface TxResult {
  txHash: string;
  blockHash: string;
  blockNumber?: number;
  events: TxEvent[];
}

export interface TxEvent {
  section: string;
  method: string;
  data: unknown;
}

const TX_TIMEOUT_MS = 60_000;

export async function executeTx(
  api: GearApi,
  extrinsic: AnyExtrinsic,
  account: KeyringPair,
): Promise<TxResult> {
  return new Promise<TxResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CliError('Transaction not included in block within 60s', 'TX_TIMEOUT'));
    }, TX_TIMEOUT_MS);

    extrinsic
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .signAndSend(account, ({ events, status }: { events: any[]; status: any }) => {
        if (status.isInBlock) {
          clearTimeout(timer);
          const blockHash = status.asInBlock.toHex();
          verbose(`Transaction included in block ${blockHash}`);

          const txEvents: TxEvent[] = [];
          let failed = false;
          let failedError = '';

          for (const { event } of events) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (api.events.system.ExtrinsicFailed.is(event as any)) {
              failed = true;
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const errorData = api.getExtrinsicFailedError(event as any);
                failedError = `${errorData.docs || errorData.method}: ${errorData.docs}`;
              } catch {
                failedError = 'Transaction failed with unknown error';
              }
            }

            txEvents.push({
              section: event.section,
              method: event.method,
              data: event.data.toJSON(),
            });
          }

          if (failed) {
            reject(new CliError(failedError, 'TX_FAILED'));
            return;
          }

          resolve({
            txHash: extrinsic.hash.toHex(),
            blockHash,
            events: txEvents,
          });
        }
      })
      .catch((err: Error) => {
        clearTimeout(timer);
        reject(new CliError(err.message, 'TX_SUBMIT_FAILED'));
      });
  });
}
