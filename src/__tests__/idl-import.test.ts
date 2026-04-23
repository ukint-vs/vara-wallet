import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Redirect cache dir before importing modules that read env at load time.
const testDir = path.join(os.tmpdir(), `vara-idl-import-test-${Date.now()}-${process.pid}`);
process.env.VARA_WALLET_DIR = testDir;

// Mock the API singleton — `idl import --program` calls api.program.codeId
// but `idl import --code-id` must not touch the api at all.
const mockCodeId = jest.fn();
jest.mock('../services/api', () => ({
  getApi: jest.fn().mockResolvedValue({
    program: { codeId: (pid: string) => mockCodeId(pid) },
  }),
}));

import { Command } from 'commander';
import { registerIdlCommand } from '../commands/idl';
import { readCachedIdl } from '../services/idl-cache';
import { setOutputOptions } from '../utils/output';

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit on parse errors
  program.option('--ws <endpoint>');
  program.option('--json');
  registerIdlCommand(program);
  return program;
}

const IDL_V2 = '!@sails: 1.0.0-beta.1\nservice Counter@0x00 { query Value : () -> u32; };';
const IDL_V1 = 'service Counter { query Value : () -> u32; };';
const CODE_ID = '0x' + 'cc'.repeat(32);
const PROGRAM_ID = '0x' + 'dd'.repeat(32);

let tmpDir: string;
let stdoutWrite: jest.SpyInstance;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vara-idl-import-case-'));
  mockCodeId.mockReset();
  stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  setOutputOptions({ json: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  stdoutWrite.mockRestore();
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function writeIdlFile(contents: string): string {
  const p = path.join(tmpDir, 'my.idl');
  fs.writeFileSync(p, contents);
  return p;
}

describe('idl import', () => {
  it('--code-id path writes cache without calling api', async () => {
    const idlFile = writeIdlFile(IDL_V2);
    const program = createProgram();
    await program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', CODE_ID]);

    const cached = readCachedIdl(CODE_ID);
    expect(cached?.idl).toBe(IDL_V2);
    expect(cached?.meta.source).toBe('import');
    expect(cached?.meta.version).toBe('v2');
    expect(mockCodeId).not.toHaveBeenCalled();
  });

  it('--program path resolves codeId via api.program.codeId and writes cache', async () => {
    mockCodeId.mockResolvedValueOnce(CODE_ID);
    const idlFile = writeIdlFile(IDL_V1);
    const program = createProgram();
    await program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--program', PROGRAM_ID]);

    expect(mockCodeId).toHaveBeenCalledTimes(1);
    expect(mockCodeId).toHaveBeenCalledWith(PROGRAM_ID);

    const cached = readCachedIdl(CODE_ID);
    expect(cached?.idl).toBe(IDL_V1);
    expect(cached?.meta.source).toBe('import');
    expect(cached?.meta.version).toBe('unknown'); // no !@sails: directive
  });

  it('rejects when neither --code-id nor --program is provided', async () => {
    const idlFile = writeIdlFile(IDL_V1);
    const program = createProgram();
    await expect(
      program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile]),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('rejects when both --code-id and --program are provided', async () => {
    const idlFile = writeIdlFile(IDL_V1);
    const program = createProgram();
    await expect(
      program.parseAsync([
        'node', 'vara-wallet', 'idl', 'import', idlFile,
        '--code-id', CODE_ID,
        '--program', PROGRAM_ID,
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('throws IDL_FILE_NOT_FOUND when the IDL file is missing', async () => {
    const missing = path.join(tmpDir, 'missing.idl');
    const program = createProgram();
    await expect(
      program.parseAsync(['node', 'vara-wallet', 'idl', 'import', missing, '--code-id', CODE_ID]),
    ).rejects.toMatchObject({ code: 'IDL_FILE_NOT_FOUND' });
  });

  it('rejects --code-id containing path traversal sequences', async () => {
    const idlFile = writeIdlFile(IDL_V1);
    const program = createProgram();
    await expect(
      program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', '../../etc/passwd']),
    ).rejects.toMatchObject({ code: 'INVALID_CODE_ID' });
  });

  it('rejects --code-id that is not 32 bytes of hex', async () => {
    const idlFile = writeIdlFile(IDL_V1);
    const program = createProgram();
    // Short hex (16 bytes, not 32)
    await expect(
      program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', '0xdeadbeef']),
    ).rejects.toMatchObject({ code: 'INVALID_CODE_ID' });
    // Non-hex chars
    await expect(
      program.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', '0x' + 'z'.repeat(64)]),
    ).rejects.toMatchObject({ code: 'INVALID_CODE_ID' });
  });

  it('accepts --code-id with and without 0x prefix (64 hex chars)', async () => {
    const idlFile = writeIdlFile(IDL_V1);
    const prefixed = '0x' + '1'.repeat(64);
    const program1 = createProgram();
    await program1.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', prefixed]);
    expect(readCachedIdl(prefixed)).not.toBeNull();

    const bare = '2'.repeat(64);
    const program2 = createProgram();
    await program2.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlFile, '--code-id', bare]);
    expect(readCachedIdl(bare)).not.toBeNull();
  });

  it('tags v2 IDLs with version="v2" and v1 IDLs with version="unknown"', async () => {
    const idlV2 = writeIdlFile(IDL_V2);
    const program1 = createProgram();
    await program1.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlV2, '--code-id', '0x' + 'aa'.repeat(32)]);
    expect(readCachedIdl('0x' + 'aa'.repeat(32))?.meta.version).toBe('v2');

    const idlV1 = writeIdlFile(IDL_V1);
    const program2 = createProgram();
    await program2.parseAsync(['node', 'vara-wallet', 'idl', 'import', idlV1, '--code-id', '0x' + 'bb'.repeat(32)]);
    expect(readCachedIdl('0x' + 'bb'.repeat(32))?.meta.version).toBe('unknown');
  });
});
