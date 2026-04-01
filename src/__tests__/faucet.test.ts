import { setOutputOptions } from '../utils/output';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock getApi
jest.mock('../services/api', () => ({
  getApi: jest.fn().mockResolvedValue({
    balance: {
      findOut: jest.fn().mockResolvedValue({ toBigInt: () => 0n }),
    },
    genesisHash: {
      toHex: () => '0x525639f713f397dcf839bd022cd821f367ebcf179de7b9253531f8adbe5436d6',
    },
  }),
}));

// Mock account resolution
jest.mock('../services/account', () => ({
  resolveAccount: jest.fn().mockResolvedValue({
    address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    sign: jest.fn().mockReturnValue(new Uint8Array(64)),
  }),
  resolveAddress: jest.fn().mockResolvedValue('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'),
}));

import { Command } from 'commander';
import { registerFaucetCommand } from '../commands/faucet';
import { CliError } from '../utils';

function createProgram() {
  const program = new Command();
  program.option('--ws <endpoint>');
  program.option('--seed <seed>');
  program.option('--json');
  registerFaucetCommand(program);
  return program;
}

function mockFetchResponses(challengeResponse: any, claimResponse?: any) {
  mockFetch.mockReset();
  let callCount = 0;
  mockFetch.mockImplementation(async (url: string) => {
    callCount++;
    if (url.includes('/agent/challenge')) {
      if (typeof challengeResponse === 'function') return challengeResponse();
      return challengeResponse;
    }
    if (url.includes('/agent/vara-testnet/request')) {
      if (typeof claimResponse === 'function') return claimResponse();
      return claimResponse || { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

describe('faucet command', () => {
  let stdoutWrite: jest.SpyInstance;

  beforeEach(() => {
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    setOutputOptions({ json: true });
    mockFetch.mockReset();
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    setOutputOptions({});
    delete process.env.VARA_FAUCET_URL;
  });

  it('should output already_funded when balance is sufficient', async () => {
    const { getApi } = require('../services/api');
    getApi.mockResolvedValueOnce({
      balance: {
        findOut: jest.fn().mockResolvedValue({ toBigInt: () => 2000_000_000_000_000n }),
      },
      genesisHash: { toHex: () => '0x5256...' },
    });

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'faucet', '--json']);

    const written = stdoutWrite.mock.calls.map((c: any) => c[0]).join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed.status).toBe('already_funded');
  });

  it('should complete the challenge-sign-claim flow successfully', async () => {
    mockFetchResponses(
      { ok: true, status: 200, json: async () => ({ nonce: '0x' + 'ab'.repeat(32), expiresIn: 60 }) },
      { ok: true, status: 200, json: async () => ({}) },
    );

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'faucet', '--json']);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const written = stdoutWrite.mock.calls.map((c: any) => c[0]).join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed.status).toBe('submitted');
    expect(parsed.address).toBeDefined();
  });

  it('should throw AUTH_ERROR on 401 from claim', async () => {
    mockFetchResponses(
      { ok: true, status: 200, json: async () => ({ nonce: '0x' + 'ab'.repeat(32) }) },
      { ok: false, status: 401, json: async () => ({ error: 'Invalid signature' }) },
    );

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'faucet', '--json'])).rejects.toThrow(
      expect.objectContaining({ code: 'AUTH_ERROR' }),
    );
  });

  it('should throw FAUCET_LIMIT on 403 from claim', async () => {
    mockFetchResponses(
      { ok: true, status: 200, json: async () => ({ nonce: '0x' + 'ab'.repeat(32) }) },
      { ok: false, status: 403, json: async () => ({ error: 'Limit reached' }) },
    );

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'faucet', '--json'])).rejects.toThrow(
      expect.objectContaining({ code: 'FAUCET_LIMIT' }),
    );
  });

  it('should throw RATE_LIMITED on 429 from claim', async () => {
    mockFetchResponses(
      { ok: true, status: 200, json: async () => ({ nonce: '0x' + 'ab'.repeat(32) }) },
      { ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) },
    );

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'faucet', '--json'])).rejects.toThrow(
      expect.objectContaining({ code: 'RATE_LIMITED' }),
    );
  });

  it('should throw CONNECTION_FAILED on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'faucet', '--json'])).rejects.toThrow(CliError);
  });

  it('should use VARA_FAUCET_URL env var', async () => {
    process.env.VARA_FAUCET_URL = 'http://custom-faucet:3010';
    mockFetchResponses(
      { ok: true, status: 200, json: async () => ({ nonce: '0x' + 'ab'.repeat(32) }) },
      { ok: true, status: 200, json: async () => ({}) },
    );

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'faucet', '--json']);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('http://custom-faucet:3010'),
      expect.anything(),
    );
  });

  it('should propagate challenge endpoint errors', async () => {
    mockFetchResponses({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Too many challenge requests' }),
    });

    const program = createProgram();
    await expect(program.parseAsync(['node', 'test', 'faucet', '--json'])).rejects.toThrow(CliError);
  });
});
