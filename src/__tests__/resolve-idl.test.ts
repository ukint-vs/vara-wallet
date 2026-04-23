import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Redirect VARA_WALLET_DIR before importing anything that consults it,
// so the real IDL cache lives under a throwaway directory for the test.
const testDir = path.join(os.tmpdir(), `vara-resolve-idl-test-${Date.now()}-${process.pid}`);
process.env.VARA_WALLET_DIR = testDir;

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { _resolveIdlForTests, _resetParserCache } from '../services/sails';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { evictCachedIdl, writeCachedIdl, readCachedIdl } from '../services/idl-cache';
import { SailsIdlParser as V1Parser } from 'sails-js-parser';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { GearApi } from '@gear-js/api';
import type { Sails } from 'sails-js';

const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function buildWasmWithSailsIdl(idl: string): Uint8Array {
  const nameBytes = new TextEncoder().encode('sails:idl');
  const payload = new TextEncoder().encode(idl);
  const nameLen = uleb128(nameBytes.length);
  const sectionBodyLen = nameLen.length + nameBytes.length + payload.length;
  const chunks: number[] = [...WASM_HEADER];
  chunks.push(0x00); // custom section
  chunks.push(...uleb128(sectionBodyLen));
  chunks.push(...nameLen);
  chunks.push(...nameBytes);
  chunks.push(...payload);
  return new Uint8Array(chunks);
}

const TEST_IDL_V1 = 'service Counter { query Value : () -> u32; };';
const TEST_IDL_V2 = '!@sails: 1.0.0-beta.1\nservice Counter@0x00 { query Value : () -> u32; };';

const CODE_ID = '0x' + 'aa'.repeat(32);
const PROGRAM_ID = '0x' + 'bb'.repeat(32);

interface Option<T> {
  isSome: boolean;
  unwrap(): { toU8a(): T };
}

function makeSome(bytes: Uint8Array): Option<Uint8Array> {
  return { isSome: true, unwrap: () => ({ toU8a: () => bytes }) };
}

function makeNone(): Option<Uint8Array> {
  return { isSome: false, unwrap: () => { throw new Error('unwrap on None'); } };
}

interface StubApi {
  program: { codeId: jest.Mock<Promise<string>, [string]> };
  query: { gearProgram: { originalCodeStorage: jest.Mock<Promise<Option<Uint8Array>>, [string]> } };
}

function makeApi(overrides: Partial<{
  codeId: (pid: string) => Promise<string>;
  originalCodeStorage: (cid: string) => Promise<Option<Uint8Array>>;
}> = {}): StubApi {
  const codeIdFn = jest.fn(overrides.codeId ?? (async () => CODE_ID));
  const storageFn = jest.fn(overrides.originalCodeStorage ?? (async () => makeNone()));
  return {
    program: { codeId: codeIdFn as jest.Mock<Promise<string>, [string]> },
    query: { gearProgram: { originalCodeStorage: storageFn as jest.Mock<Promise<Option<Uint8Array>>, [string]> } },
  };
}

function apiArg(stub: StubApi): GearApi {
  return stub as unknown as GearApi;
}

let parser: V1Parser;

beforeAll(async () => {
  // The v1 parser is needed for validator-gate tests. Ok to share across cases.
  parser = await V1Parser.new();
});

beforeEach(() => {
  // Fresh cache dir per test so reads don't leak between cases.
  fs.rmSync(testDir, { recursive: true, force: true });
  _resetParserCache();
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('resolveIdl :: stage 1 (--idl file)', () => {
  it('reads the file and returns its contents', async () => {
    const tmpFile = path.join(testDir, 'my.idl');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(tmpFile, TEST_IDL_V1);

    const api = makeApi();
    const got = await _resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID, idl: tmpFile }, null);
    expect(got).toBe(TEST_IDL_V1);
    // Does not touch the chain.
    expect(api.program.codeId).not.toHaveBeenCalled();
    expect(api.query.gearProgram.originalCodeStorage).not.toHaveBeenCalled();
  });

  it('throws IDL_FILE_ERROR on missing file', async () => {
    const api = makeApi();
    const missing = path.join(testDir, 'does-not-exist.idl');
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID, idl: missing }, null))
      .rejects.toMatchObject({ code: 'IDL_FILE_ERROR' });
  });
});

describe('resolveIdl :: codeId lookup failure', () => {
  it('falls through to stage 4/5 without throwing when codeId() rejects', async () => {
    const api = makeApi({
      codeId: async () => { throw new Error('rpc connection dropped'); },
    });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });
    // originalCodeStorage must not be called when codeId failed.
    expect(api.query.gearProgram.originalCodeStorage).not.toHaveBeenCalled();
  });
});

describe('resolveIdl :: stage 2 (cache hit)', () => {
  it('returns cached entry and does not fetch WASM when no validator', async () => {
    writeCachedIdl(CODE_ID, TEST_IDL_V1, {
      version: 'unknown',
      source: 'import',
      importedAt: new Date().toISOString(),
    });
    const api = makeApi();
    const got = await _resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null);
    expect(got).toBe(TEST_IDL_V1);
    expect(api.query.gearProgram.originalCodeStorage).not.toHaveBeenCalled();
  });

  it('validator gate: returns when cached IDL passes validator', async () => {
    writeCachedIdl(CODE_ID, TEST_IDL_V1, {
      version: 'unknown', source: 'import', importedAt: new Date().toISOString(),
    });
    const api = makeApi();
    const validator = (sails: Sails): boolean => 'Counter' in sails.services;

    const got = await _resolveIdlForTests(
      apiArg(api),
      { programId: PROGRAM_ID, idlValidator: validator },
      parser,
    );
    expect(got).toBe(TEST_IDL_V1);
  });

  it('validator gate: evicts cached IDL that validator rejects, then falls through', async () => {
    writeCachedIdl(CODE_ID, TEST_IDL_V1, {
      version: 'unknown', source: 'import', importedAt: new Date().toISOString(),
    });
    const api = makeApi();
    const validator = (): boolean => false; // rejects any IDL

    // No bundled IDLs passed → cascade ends at stage 5 with IDL_NOT_FOUND.
    await expect(_resolveIdlForTests(
      apiArg(api),
      { programId: PROGRAM_ID, idlValidator: validator, bundledIdls: [] },
      parser,
    )).rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });

    // Entry must have been evicted.
    expect(readCachedIdl(CODE_ID)).toBeNull();
  });
});

describe('resolveIdl :: stage 3 (chain WASM)', () => {
  it('extracts IDL from sails:idl section, writes cache, returns', async () => {
    const wasm = buildWasmWithSailsIdl(TEST_IDL_V2);
    const api = makeApi({ originalCodeStorage: async () => makeSome(wasm) });

    const got = await _resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null);
    expect(got).toBe(TEST_IDL_V2);

    const cached = readCachedIdl(CODE_ID);
    expect(cached?.idl).toBe(TEST_IDL_V2);
    expect(cached?.meta.source).toBe('chain');
    expect(cached?.meta.version).toBe('v2');
  });

  it('falls through when originalCodeStorage returns None', async () => {
    const api = makeApi({ originalCodeStorage: async () => makeNone() });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });
    expect(readCachedIdl(CODE_ID)).toBeNull();
  });

  it('falls through when WASM has no sails:idl section (v1 program)', async () => {
    const api = makeApi({ originalCodeStorage: async () => makeSome(WASM_HEADER) });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });
    expect(readCachedIdl(CODE_ID)).toBeNull();
  });

  it('throws IDL_PARSE_ERROR on malformed WASM', async () => {
    // Wrong magic triggers WebAssembly.Module validation error.
    const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00]);
    const api = makeApi({ originalCodeStorage: async () => makeSome(bad) });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_PARSE_ERROR' });
  });

  it('falls through on oversized WASM', async () => {
    // 11MB > MAX_WASM_BYTES (10MB). We only check the length; content doesn't
    // matter because the size guard runs before extraction.
    const oversized = new Uint8Array(11 * 1024 * 1024);
    const api = makeApi({ originalCodeStorage: async () => makeSome(oversized) });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });
  });

  it('falls through when originalCodeStorage RPC throws', async () => {
    const api = makeApi({
      originalCodeStorage: async () => { throw new Error('rpc drop'); },
    });
    await expect(_resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null))
      .rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });
  });

  it('validator gate (post-fetch): chain IDL rejected → no cache write, falls through', async () => {
    const wasm = buildWasmWithSailsIdl(TEST_IDL_V1);
    const api = makeApi({ originalCodeStorage: async () => makeSome(wasm) });
    const validator = (): boolean => false;

    await expect(_resolveIdlForTests(
      apiArg(api),
      { programId: PROGRAM_ID, idlValidator: validator, bundledIdls: [] },
      parser,
    )).rejects.toMatchObject({ code: 'IDL_NOT_FOUND' });

    // Cache NOT populated with the rejected IDL.
    expect(readCachedIdl(CODE_ID)).toBeNull();
  });
});

describe('resolveIdl :: stage 4 (bundled)', () => {
  it('bundled validator matches → returns (cache not written)', async () => {
    const api = makeApi({ originalCodeStorage: async () => makeNone() });
    const validator = (sails: Sails): boolean => 'Counter' in sails.services;

    const got = await _resolveIdlForTests(
      apiArg(api),
      { programId: PROGRAM_ID, idlValidator: validator, bundledIdls: [TEST_IDL_V1] },
      parser,
    );
    expect(got).toBe(TEST_IDL_V1);
    // Bundled hits are intentionally not cached.
    expect(readCachedIdl(CODE_ID)).toBeNull();
  });
});

describe('resolveIdl :: stage 5 (IDL_NOT_FOUND hint)', () => {
  it('hint mentions `idl import` and does NOT mention `meta-storage`', async () => {
    const api = makeApi({ originalCodeStorage: async () => makeNone() });
    try {
      await _resolveIdlForTests(apiArg(api), { programId: PROGRAM_ID }, null);
      fail('expected throw');
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain('idl import');
      expect(msg.toLowerCase()).not.toContain('meta-storage');
      expect(msg.toLowerCase()).not.toContain('metastorage');
    }
  });
});
