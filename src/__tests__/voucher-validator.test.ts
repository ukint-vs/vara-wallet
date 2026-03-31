import { validateVoucher } from '../services/voucher-validator';
import { CliError } from '../utils/errors';

const VALID_ID = '0x' + 'a'.repeat(64);
const PROGRAM_A = '0x' + 'c'.repeat(64);
const PROGRAM_B = '0x' + 'd'.repeat(64);

// Helper to create a mock API with configurable voucher details
function mockApi(details?: Record<string, unknown>, rejectWith?: Error) {
  return {
    voucher: {
      getDetails: rejectWith
        ? jest.fn().mockRejectedValue(rejectWith)
        : jest.fn().mockResolvedValue(details ?? {}),
    },
    rpc: {
      chain: {
        getHeader: jest.fn().mockResolvedValue({
          number: { toNumber: () => 1000 },
        }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('validateVoucher', () => {
  describe('format validation', () => {
    const api = mockApi(undefined, new Error('not connected'));

    it('rejects non-hex voucher ID', async () => {
      await expect(validateVoucher(api, '0x01', 'not-hex'))
        .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
    });

    it('rejects voucher ID without 0x prefix', async () => {
      await expect(validateVoucher(api, '0x01', 'a'.repeat(64)))
        .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
    });

    it('rejects voucher ID with wrong length', async () => {
      await expect(validateVoucher(api, '0x01', '0x' + 'a'.repeat(32)))
        .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
    });

    it('rejects voucher ID with invalid hex characters', async () => {
      await expect(validateVoucher(api, '0x01', '0x' + 'g'.repeat(64)))
        .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
    });

    it('does not call API for invalid format', async () => {
      try { await validateVoucher(api, '0x01', 'bad'); } catch { /* expected */ }
      expect(api.voucher.getDetails).not.toHaveBeenCalled();
    });
  });

  describe('API lookup failures', () => {
    it('wraps network errors as VOUCHER_NOT_FOUND with detail', async () => {
      const api = mockApi(undefined, new Error('WebSocket closed'));
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .rejects.toMatchObject({ code: 'VOUCHER_NOT_FOUND' });
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .rejects.toThrow(/WebSocket closed/);
    });

    it('passes accountHex and voucherId to getDetails', async () => {
      const api = mockApi({ programs: null });
      await validateVoucher(api, '0xaccount', VALID_ID);
      expect(api.voucher.getDetails).toHaveBeenCalledWith('0xaccount', VALID_ID);
    });
  });

  describe('program restriction', () => {
    it('passes when voucher has no program restrictions', async () => {
      const api = mockApi({ programs: null });
      await expect(validateVoucher(api, '0x01', VALID_ID, PROGRAM_A))
        .resolves.toBeUndefined();
    });

    it('passes when program is in the allowed list', async () => {
      const api = mockApi({ programs: [PROGRAM_A] });
      await expect(validateVoucher(api, '0x01', VALID_ID, PROGRAM_A))
        .resolves.toBeUndefined();
    });

    it('rejects when program is not in the allowed list', async () => {
      const api = mockApi({ programs: [PROGRAM_B] });
      await expect(validateVoucher(api, '0x01', VALID_ID, PROGRAM_A))
        .rejects.toMatchObject({ code: 'VOUCHER_PROGRAM_MISMATCH' });
    });

    it('compares program IDs case-insensitively', async () => {
      const upper = '0x' + 'C'.repeat(64);
      const lower = '0x' + 'c'.repeat(64);
      const api = mockApi({ programs: [upper] });
      await expect(validateVoucher(api, '0x01', VALID_ID, lower))
        .resolves.toBeUndefined();
    });

    it('skips program check when no programId provided', async () => {
      const api = mockApi({ programs: [PROGRAM_B] });
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .resolves.toBeUndefined();
    });
  });

  describe('expiry check', () => {
    it('passes when voucher has not expired', async () => {
      const api = mockApi({ programs: null, expiry: 2000 }); // current block = 1000
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .resolves.toBeUndefined();
    });

    it('rejects when voucher has expired', async () => {
      const api = mockApi({ programs: null, expiry: 500 }); // current block = 1000
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .rejects.toMatchObject({ code: 'VOUCHER_EXPIRED' });
    });

    it('rejects when voucher expires at current block exactly', async () => {
      const api = mockApi({ programs: null, expiry: 1000 }); // current = 1000
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .rejects.toMatchObject({ code: 'VOUCHER_EXPIRED' });
    });

    it('handles BN-style expiry objects via Number()', async () => {
      // BN-like with toString() that Number() can coerce
      const bnExpired = { toNumber: () => 500, toString: () => '500' };
      const api1 = mockApi({ programs: null, expiry: bnExpired });
      await expect(validateVoucher(api1, '0x01', VALID_ID))
        .rejects.toMatchObject({ code: 'VOUCHER_EXPIRED' });

      const bnValid = { toNumber: () => 2000, toString: () => '2000' };
      const api2 = mockApi({ programs: null, expiry: bnValid });
      await expect(validateVoucher(api2, '0x01', VALID_ID))
        .resolves.toBeUndefined();
    });

    it('continues if block header fetch fails', async () => {
      const api = mockApi({ programs: null, expiry: 500 });
      api.rpc.chain.getHeader = jest.fn().mockRejectedValue(new Error('RPC down'));
      // Should not throw — expiry check is best-effort
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .resolves.toBeUndefined();
    });
  });

  describe('codeUploading permission', () => {
    it('passes when codeUploading is true and required', async () => {
      const api = mockApi({ programs: null, codeUploading: true });
      await expect(validateVoucher(api, '0x01', VALID_ID, undefined, { requireCodeUploading: true }))
        .resolves.toBeUndefined();
    });

    it('rejects when codeUploading is false and required', async () => {
      const api = mockApi({ programs: null, codeUploading: false });
      await expect(validateVoucher(api, '0x01', VALID_ID, undefined, { requireCodeUploading: true }))
        .rejects.toMatchObject({ code: 'VOUCHER_CODE_UPLOADING_DISABLED' });
    });

    it('skips codeUploading check when not required', async () => {
      const api = mockApi({ programs: null, codeUploading: false });
      await expect(validateVoucher(api, '0x01', VALID_ID))
        .resolves.toBeUndefined();
    });
  });

  describe('combined validation', () => {
    it('checks format before API call', async () => {
      const api = mockApi({ programs: null });
      await expect(validateVoucher(api, '0x01', 'bad'))
        .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
      expect(api.voucher.getDetails).not.toHaveBeenCalled();
    });

    it('checks program restriction before expiry', async () => {
      // Both would fail, but program check comes first
      const api = mockApi({ programs: [PROGRAM_B], expiry: 500 });
      await expect(validateVoucher(api, '0x01', VALID_ID, PROGRAM_A))
        .rejects.toMatchObject({ code: 'VOUCHER_PROGRAM_MISMATCH' });
    });

    it('full valid path: format + program + expiry + codeUploading', async () => {
      const api = mockApi({
        programs: [PROGRAM_A],
        expiry: 2000,
        codeUploading: true,
      });
      await expect(
        validateVoucher(api, '0x01', VALID_ID, PROGRAM_A, { requireCodeUploading: true }),
      ).resolves.toBeUndefined();
    });
  });
});
