import { Command } from 'commander';
import { BN } from '@polkadot/util';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError, resolveAmount, minimalToVara } from '../utils';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Query account balance')
    .argument('[address]', 'account address (defaults to configured account)')
    .action(async (address?: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const resolvedAddress = await resolveAddress(address, opts);

      verbose(`Querying balance for ${resolvedAddress}`);
      const balance = await api.balance.findOut(resolvedAddress);
      const balanceRaw = balance.toBigInt();

      output({
        address: resolvedAddress,
        balance: minimalToVara(balanceRaw),
        balanceRaw: balanceRaw.toString(),
      });
    });

  program
    .command('transfer')
    .description('Transfer VARA tokens')
    .argument('<to>', 'destination address')
    .argument('<amount>', 'amount to transfer (in VARA by default)')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .action(async (to: string, amount: string, options: { units?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const amountMinimal = resolveAmount(amount, isRaw);

      if (amountMinimal <= 0n) {
        throw new CliError('Amount must be positive', 'INVALID_AMOUNT');
      }

      verbose(`Transferring ${minimalToVara(amountMinimal)} VARA from ${account.address} to ${to}`);

      const tx = api.balance.transfer(to, new BN(amountMinimal.toString()));
      const result = await executeTx(api, tx, account);

      output({
        txHash: result.txHash,
        blockHash: result.blockHash,
        from: account.address,
        to,
        amount: minimalToVara(amountMinimal),
        amountRaw: amountMinimal.toString(),
      });
    });
}
