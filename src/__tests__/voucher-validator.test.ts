import { validateVoucher } from '../services/voucher-validator';
import { CliError } from '../utils/errors';

// Only test the synchronous format validation (the async API calls require a real chain connection)
describe('validateVoucher format validation', () => {
  const fakeApi = {
    voucher: {
      getDetails: jest.fn().mockRejectedValue(new Error('not connected')),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('rejects non-hex voucher ID', async () => {
    await expect(validateVoucher(fakeApi, '0x01', 'not-hex'))
      .rejects.toThrow(CliError);
    await expect(validateVoucher(fakeApi, '0x01', 'not-hex'))
      .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
  });

  it('rejects voucher ID without 0x prefix', async () => {
    const validHex = 'a'.repeat(64);
    await expect(validateVoucher(fakeApi, '0x01', validHex))
      .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
  });

  it('rejects voucher ID with wrong length', async () => {
    await expect(validateVoucher(fakeApi, '0x01', '0x' + 'a'.repeat(32)))
      .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
  });

  it('rejects voucher ID with invalid hex characters', async () => {
    await expect(validateVoucher(fakeApi, '0x01', '0x' + 'g'.repeat(64)))
      .rejects.toMatchObject({ code: 'INVALID_VOUCHER_ID' });
  });

  it('accepts valid format but fails on API call (expected)', async () => {
    const validId = '0x' + 'a'.repeat(64);
    await expect(validateVoucher(fakeApi, '0x01', validId))
      .rejects.toMatchObject({ code: 'VOUCHER_NOT_FOUND' });
  });

  it('passes program mismatch check when voucher has program restrictions', async () => {
    const validId = '0x' + 'b'.repeat(64);
    const programId = '0x' + 'c'.repeat(64);
    const mockApi = {
      voucher: {
        getDetails: jest.fn().mockResolvedValue({
          programs: ['0x' + 'd'.repeat(64)], // different program
          owner: '0x01',
          expiry: 999999,
        }),
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(validateVoucher(mockApi, '0x01', validId, programId))
      .rejects.toMatchObject({ code: 'VOUCHER_PROGRAM_MISMATCH' });
  });

  it('passes when voucher has no program restrictions', async () => {
    const validId = '0x' + 'b'.repeat(64);
    const programId = '0x' + 'c'.repeat(64);
    const mockApi = {
      voucher: {
        getDetails: jest.fn().mockResolvedValue({
          programs: null, // unrestricted
          owner: '0x01',
          expiry: 999999,
        }),
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(validateVoucher(mockApi, '0x01', validId, programId))
      .resolves.toBeUndefined();
  });

  it('passes when voucher program list includes the target', async () => {
    const validId = '0x' + 'b'.repeat(64);
    const programId = '0x' + 'c'.repeat(64);
    const mockApi = {
      voucher: {
        getDetails: jest.fn().mockResolvedValue({
          programs: [programId],
          owner: '0x01',
          expiry: 999999,
        }),
      },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(validateVoucher(mockApi, '0x01', validId, programId))
      .resolves.toBeUndefined();
  });
});
