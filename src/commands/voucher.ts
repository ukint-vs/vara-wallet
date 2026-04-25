import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, resolveAmount, minimalToVara, addressToHex } from '../utils';

export function registerVoucherCommand(program: Command): void {
  const voucher = program.command('voucher').description('Voucher operations');

  voucher
    .command('issue')
    .description('Issue a voucher for a spender')
    .argument('<spender>', 'spender address (hex or SS58)')
    .argument('<value>', 'voucher value (in VARA)')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
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
      const amount = resolveAmount(value, options.units);

      const duration = options.duration ? parseInt(options.duration, 10) : undefined;
      const programs = options.programs
        ? options.programs.split(',').map((p) => addressToHex(p.trim()))
        : undefined;

      const spenderHex = addressToHex(spender);
      verbose(`Issuing voucher for ${spenderHex} with value ${minimalToVara(amount)} VARA`);

      const { extrinsic, voucherId } = await api.voucher.issue(
        spenderHex,
        amount,
        duration,
        programs,
      );

      const txResult = await executeTx(api, extrinsic, account);

      output({
        voucherId,
        spender: spenderHex,
        value: minimalToVara(amount),
        valueRaw: amount.toString(),
        duration: duration || null,
        programs: programs || null,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        blockNumber: txResult.blockNumber,
      });
    });

  voucher
    .command('list')
    .description('List vouchers for an account')
    .argument('<account>', 'account address (hex or SS58)')
    .option('--program <id>', 'filter by program ID')
    .action(async (accountAddr: string, options: { program?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const accountHex = addressToHex(accountAddr);
      verbose(`Fetching vouchers for ${accountHex}`);

      const vouchers = await api.voucher.getAllForAccount(
        accountHex,
        options.program ? addressToHex(options.program) : undefined,
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
    .argument('<spender>', 'spender address (hex or SS58)')
    .argument('<voucherId>', 'voucher ID')
    .action(async (spender: string, voucherId: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const spenderHex = addressToHex(spender);
      verbose(`Revoking voucher ${voucherId}`);

      const tx = api.voucher.revoke(spenderHex, voucherId);
      const txResult = await executeTx(api, tx, account);

      output({
        voucherId,
        spender: spenderHex,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        blockNumber: txResult.blockNumber,
      });
    });
}
