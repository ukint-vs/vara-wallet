import { Command } from 'commander';
import { BN } from '@polkadot/util';
import { encodeAddress } from '@polkadot/util-crypto';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex } from '../utils';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Query account balance')
    .argument('[address]', 'account address, hex or SS58 (defaults to configured account)')
    .action(async (address?: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const resolvedAddress = await resolveAddress(address, opts);

      verbose(`Querying balance for ${resolvedAddress}`);
      const balance = await api.balance.findOut(resolvedAddress);
      const balanceRaw = balance.toBigInt();
      const ss58Prefix = (api.registry.chainSS58 as number | undefined) ?? 137;

      output({
        address: resolvedAddress,
        addressSS58: encodeAddress(resolvedAddress, ss58Prefix),
        balance: minimalToVara(balanceRaw),
        balanceRaw: balanceRaw.toString(),
      });
    });

  program
    .command('transfer')
    .description('Transfer VARA tokens')
    .argument('<to>', 'destination address (hex or SS58)')
    .argument('[amount]', 'amount to transfer (in VARA by default)')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--all', 'transfer entire balance (account will be reaped)')
    .action(async (to: string, amount: string | undefined, options: { units?: string; all?: boolean }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      if (!amount && !options.all) {
        throw new CliError('Provide <amount> or use --all', 'INVALID_ARGS');
      }
      if (amount && options.all) {
        throw new CliError('Cannot use --all with an explicit amount', 'INVALID_ARGS');
      }

      const toHex = addressToHex(to);
      const ss58Prefix = (api.registry.chainSS58 as number | undefined) ?? 137;

      if (options.all) {
        const balance = await api.balance.findOut(account.address);
        const balanceRaw = balance.toBigInt();

        verbose(`Transferring all ${minimalToVara(balanceRaw)} VARA from ${account.address} to ${toHex}`);

        const tx = api.tx.balances.transferAll(toHex, false);
        const result = await executeTx(api, tx, account);

        output({
          txHash: result.txHash,
          blockHash: result.blockHash,
          blockNumber: result.blockNumber,
          from: account.address,
          to: toHex,
          toSS58: encodeAddress(toHex, ss58Prefix),
          amount: minimalToVara(balanceRaw),
          amountRaw: balanceRaw.toString(),
        });
      } else {
        const amountMinimal = resolveAmount(amount!, options.units);

        if (amountMinimal <= 0n) {
          throw new CliError('Amount must be positive', 'INVALID_AMOUNT');
        }

        verbose(`Transferring ${minimalToVara(amountMinimal)} VARA from ${account.address} to ${toHex}`);

        const tx = api.balance.transfer(toHex, new BN(amountMinimal.toString()));
        const result = await executeTx(api, tx, account);

        output({
          txHash: result.txHash,
          blockHash: result.blockHash,
          blockNumber: result.blockNumber,
          from: account.address,
          to: toHex,
          toSS58: encodeAddress(toHex, ss58Prefix),
          amount: minimalToVara(amountMinimal),
          amountRaw: amountMinimal.toString(),
        });
      }
    });
}
