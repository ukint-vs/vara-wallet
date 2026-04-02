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

      const toHex = addressToHex(to);
      verbose(`Transferring ${minimalToVara(amountMinimal)} VARA from ${account.address} to ${toHex}`);

      const tx = api.balance.transfer(toHex, new BN(amountMinimal.toString()));
      const result = await executeTx(api, tx, account);

      const ss58Prefix = (api.registry.chainSS58 as number | undefined) ?? 137;

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
    });
}
