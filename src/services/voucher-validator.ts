import { GearApi } from '@gear-js/api';
import { CliError, verbose } from '../utils';

export interface ValidateVoucherOptions {
  requireCodeUploading?: boolean;
}

export async function validateVoucher(
  api: GearApi,
  accountHex: string,
  voucherId: string,
  programId?: string,
  options?: ValidateVoucherOptions,
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

    if (programId && details.programs) {
      const normalizedPrograms = details.programs.map((p: string) => p.toLowerCase());
      if (!normalizedPrograms.includes(programId.toLowerCase())) {
        throw new CliError(
          `Voucher is not valid for program ${programId}`,
          'VOUCHER_PROGRAM_MISMATCH',
        );
      }
    }

    // Check expiry against current block
    if (details.expiry) {
      try {
        const header = await api.rpc.chain.getHeader();
        const currentBlock = header.number.toNumber();
        if (typeof details.expiry === 'number' && currentBlock >= details.expiry) {
          throw new CliError(
            `Voucher expired at block ${details.expiry} (current: ${currentBlock})`,
            'VOUCHER_EXPIRED',
          );
        }
      } catch (e) {
        if (e instanceof CliError) throw e;
        // If we can't check expiry, continue (best-effort)
        verbose('Could not verify voucher expiry');
      }
    }

    // Check codeUploading permission if needed
    if (options?.requireCodeUploading && !details.codeUploading) {
      throw new CliError(
        'Voucher does not permit code uploading (codeUploading is disabled)',
        'VOUCHER_CODE_UPLOADING_DISABLED',
      );
    }
  } catch (e) {
    if (e instanceof CliError) throw e;
    const detail = e instanceof Error ? `: ${e.message}` : '';
    verbose(`Voucher validation failed${detail}`);
    throw new CliError(
      `Voucher not found or not valid for this account${detail}`,
      'VOUCHER_NOT_FOUND',
    );
  }
}
