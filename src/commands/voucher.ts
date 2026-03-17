import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, resolveAmount, minimalToVara } from '../utils';

export function registerVoucherCommand(program: Command): void {
  const voucher = program.command('voucher').description('Voucher operations');

  voucher
    .command('issue')
    .description('Issue a voucher for a spender')
    .argument('<spender>', 'spender address')
    .argument('<value>', 'voucher value (in VARA)')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--duration <blocks>', 'voucher duration in blocks')
    .option('--programs <ids>', 'comma-separated program IDs to restrict')
    .action(async (spender: string, value: string, options: {
      units?: string;
      duration?: string;
      programs?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const amount = resolveAmount(value, isRaw);

      const duration = options.duration ? parseInt(options.duration, 10) : undefined;
      const programs = options.programs
        ? options.programs.split(',').map((p) => p.trim() as `0x${string}`)
        : undefined;

      verbose(`Issuing voucher for ${spender} with value ${minimalToVara(amount)} VARA`);

      const { extrinsic, voucherId } = await api.voucher.issue(
        spender as `0x${string}`,
        amount,
        duration,
        programs,
      );

      const txResult = await executeTx(api, extrinsic, account);

      output({
        voucherId,
        spender,
        value: minimalToVara(amount),
        valueRaw: amount.toString(),
        duration: duration || null,
        programs: programs || null,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
      });
    });

  voucher
    .command('list')
    .description('List vouchers for an account')
    .argument('<account>', 'account address')
    .option('--program <id>', 'filter by program ID')
    .action(async (accountAddr: string, options: { program?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose(`Fetching vouchers for ${accountAddr}`);

      const vouchers = await api.voucher.getAllForAccount(
        accountAddr,
        options.program as `0x${string}` | undefined,
      );

      const items = Object.entries(vouchers).map(([voucherId, details]) => ({
        voucherId,
        owner: details.owner,
        expiry: details.expiry,
        programs: details.programs,
        codeUploading: details.codeUploading,
      }));

      output(items);
    });

  voucher
    .command('revoke')
    .description('Revoke a voucher')
    .argument('<spender>', 'spender address')
    .argument('<voucherId>', 'voucher ID')
    .action(async (spender: string, voucherId: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      verbose(`Revoking voucher ${voucherId}`);

      const tx = api.voucher.revoke(spender, voucherId);
      const txResult = await executeTx(api, tx, account);

      output({
        voucherId,
        spender,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
      });
    });
}
