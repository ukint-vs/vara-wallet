import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError } from '../utils';

export function registerTxCommand(program: Command): void {
  program
    .command('tx')
    .description('Submit a generic substrate extrinsic')
    .argument('<pallet>', 'pallet name (e.g. balances, system)')
    .argument('<method>', 'method name (e.g. transferKeepAlive)')
    .argument('[args...]', 'method arguments (JSON-encoded)')
    .action(async (pallet: string, method: string, args: string[]) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const palletApi = (api.tx as any)[pallet];
      if (!palletApi) {
        throw new CliError(`Pallet "${pallet}" not found`, 'PALLET_NOT_FOUND');
      }

      const methodFn = palletApi[method];
      if (!methodFn) {
        throw new CliError(`Method "${method}" not found in pallet "${pallet}"`, 'METHOD_NOT_FOUND');
      }

      // Parse arguments
      const parsedArgs = args.map((arg) => {
        try {
          return JSON.parse(arg);
        } catch {
          return arg;
        }
      });

      verbose(`Submitting tx: ${pallet}.${method}(${parsedArgs.map(String).join(', ')})`);

      const extrinsic = methodFn(...parsedArgs);
      const txResult = await executeTx(api, extrinsic, account);

      output({
        pallet,
        method,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        events: txResult.events,
      });
    });

  program
    .command('query')
    .description('Query substrate storage')
    .argument('<pallet>', 'pallet name (e.g. system, balances)')
    .argument('<method>', 'storage item name (e.g. account)')
    .argument('[args...]', 'query arguments (JSON-encoded)')
    .action(async (pallet: string, method: string, args: string[]) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const palletQuery = (api.query as any)[pallet];
      if (!palletQuery) {
        throw new CliError(`Pallet "${pallet}" not found in storage`, 'PALLET_NOT_FOUND');
      }

      const queryFn = palletQuery[method];
      if (!queryFn) {
        throw new CliError(`Storage item "${method}" not found in pallet "${pallet}"`, 'METHOD_NOT_FOUND');
      }

      const parsedArgs = args.map((arg) => {
        try {
          return JSON.parse(arg);
        } catch {
          return arg;
        }
      });

      verbose(`Querying: ${pallet}.${method}(${parsedArgs.map(String).join(', ')})`);

      const result = await queryFn(...parsedArgs);

      output({
        pallet,
        method,
        result: result.toJSON(),
      });
    });
}
