import { Command } from 'commander';
import { getApi } from '../services/api';
import { output, verbose, CliError, minimalToVara } from '../utils';

const DEFAULT_TIMEOUT_S = 30;

export function registerWaitCommand(program: Command): void {
  program
    .command('wait')
    .description('Wait for a reply to a sent message')
    .argument('<messageId>', 'message ID to wait for reply (0x...)')
    .option('--timeout <seconds>', `timeout in seconds (default: ${DEFAULT_TIMEOUT_S})`, String(DEFAULT_TIMEOUT_S))
    .action(async (messageId: string, options: { timeout: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);
      const timeoutMs = parseInt(options.timeout, 10) * 1000;

      verbose(`Waiting for reply to ${messageId} (timeout: ${options.timeout}s)`);

      const result = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          let unsubscribe: (() => void) | undefined;
          let settled = false;

          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            unsubscribe?.();
            reject(new CliError(`No reply received within ${options.timeout}s`, 'REPLY_TIMEOUT'));
          }, timeoutMs);

          api.gearEvents
            .subscribeToGearEvent('UserMessageSent', (event) => {
              if (settled) return;
              const data = event.data;
              const details = data.message.details;

              if (details && details.isSome) {
                const replyDetails = details.unwrap();
                if (replyDetails.to.toHex() === messageId) {
                  settled = true;
                  clearTimeout(timer);
                  unsubscribe?.();
                  resolve({
                    messageId: data.message.id.toHex(),
                    source: data.message.source.toHex(),
                    destination: data.message.destination.toHex(),
                    payload: data.message.payload.toHex(),
                    value: minimalToVara(data.message.value.toBigInt()),
                    replyTo: messageId,
                    replyCode: replyDetails.code.toString(),
                  });
                }
              }
            })
            .then((unsub) => {
              unsubscribe = unsub;
              if (settled) unsub();
            })
            .catch((err: unknown) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(new CliError(
                err instanceof Error ? err.message : String(err),
                'SUBSCRIPTION_FAILED',
              ));
            });
        },
      );

      output(result);
    });
}
