import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex } from '../utils';

export function registerStateCommand(program: Command): void {
  const state = program.command('state').description('Program state operations');

  state
    .command('read')
    .description('Read program state via calculateReply')
    .argument('<programId>', 'program ID (hex or SS58)')
    .option('--payload <payload>', 'state query payload (hex or JSON)', '0x')
    .option('--origin <address>', 'origin address for the query (hex or SS58)')
    .option('--at <blockHash>', 'block hash to query state at')
    .action(async (programId: string, options: {
      payload: string;
      origin?: string;
      at?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);

      let origin: `0x${string}`;
      if (options.origin) {
        origin = addressToHex(options.origin);
      } else {
        try {
          const account = await resolveAccount(opts);
          origin = addressToHex(account.address);
        } catch {
          throw new CliError(
            'Provide --origin address or configure an account for state read',
            'NO_ORIGIN',
          );
        }
      }

      const programIdHex = addressToHex(programId);
      verbose(`Reading state from program ${programIdHex}`);

      const replyInfo = await api.message.calculateReply({
        origin,
        destination: programIdHex,
        payload: options.payload,
        at: options.at as `0x${string}` | undefined,
      });

      output({
        payload: replyInfo.payload.toHex(),
        value: minimalToVara(replyInfo.value.toBigInt()),
        valueRaw: replyInfo.value.toString(),
        code: replyInfo.code.toString(),
      });
    });
}
