import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, minimalToVara } from '../utils';

export function registerMailboxCommand(program: Command): void {
  const mailbox = program.command('mailbox').description('Mailbox operations');

  mailbox
    .command('read')
    .description('Read mailbox messages for an account')
    .argument('[address]', 'account address, hex or SS58 (defaults to configured account)')
    .action(async (address?: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const resolvedAddress = await resolveAddress(address, opts);

      verbose(`Reading mailbox for ${resolvedAddress}`);

      const messages = await api.mailbox.read(resolvedAddress);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = messages.map((item: any) => {
        const [message, interval] = item;
        const msgJson = message.toJSON() as Record<string, unknown>;
        const intervalJson = interval.toJSON() as Record<string, unknown>;
        return {
          id: msgJson.id,
          source: msgJson.source,
          destination: msgJson.destination,
          payload: msgJson.payload,
          value: msgJson.value?.toString(),
          start: intervalJson.start,
          finish: intervalJson.finish,
        };
      });

      output(items);
    });

  mailbox
    .command('claim')
    .description('Claim value from a message in mailbox')
    .argument('<messageId>', 'message ID to claim (0x...)')
    .action(async (messageId: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      verbose(`Claiming value from message ${messageId}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tx = (api.mailbox as any).claimValue(messageId as `0x${string}`);
      const result = await executeTx(api, tx, account);

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        messageId,
        events: result.events,
      });
    });
}
