import { GearApi } from '@gear-js/api';
import { CliError, verbose } from '../utils';

export async function validateVoucher(
  api: GearApi,
  accountHex: string,
  voucherId: string,
  programId?: string,
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(voucherId)) {
    throw new CliError(
      'Invalid voucher ID format (expected 0x + 64 hex chars)',
      'INVALID_VOUCHER_ID',
    );
  }

  verbose(`Validating voucher ${voucherId}...`);

  try {
    const details = await api.voucher.getDetails(accountHex, voucherId);

    if (programId && details.programs && !details.programs.includes(programId)) {
      throw new CliError(
        `Voucher is not valid for program ${programId}`,
        'VOUCHER_PROGRAM_MISMATCH',
      );
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(
      'Voucher not found or not valid for this account',
      'VOUCHER_NOT_FOUND',
    );
  }
}
