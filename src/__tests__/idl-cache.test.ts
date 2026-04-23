import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Redirect VARA_WALLET_DIR before importing the module under test so the
// cache lands under a throwaway directory.
const testDir = path.join(os.tmpdir(), `vara-idl-cache-test-${Date.now()}-${process.pid}`);
process.env.VARA_WALLET_DIR = testDir;

// eslint-disable-next-line @typescript-eslint/no-var-requires
import {
  readCachedIdl,
  writeCachedIdl,
  evictCachedIdl,
  getIdlCacheDir,
  IdlCacheMeta,
} from '../services/idl-cache';

const codeIdA = '0xABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
const codeIdALower = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const meta: IdlCacheMeta = {
  version: 'v2',
  source: 'chain',
  importedAt: '2026-04-23T00:00:00.000Z',
};

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function mode(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

describe('idl-cache', () => {
  it('round-trips: write then read returns the same idl + meta', () => {
    writeCachedIdl(codeIdA, 'service Foo { query Bar : () -> u32; };', meta);
    const hit = readCachedIdl(codeIdA);
    expect(hit).not.toBeNull();
    expect(hit?.idl).toBe('service Foo { query Bar : () -> u32; };');
    expect(hit?.meta.version).toBe('v2');
    expect(hit?.meta.source).toBe('chain');
  });

  it('normalizes 0x-prefix and case — upper/lower/no-prefix collapse to one entry', () => {
    const upper = '0x' + codeIdALower.toUpperCase();
    const lower = codeIdALower;
    const bare = codeIdALower.toUpperCase();

    // They should all resolve to the same cache file as codeIdA.
    const hitUpper = readCachedIdl(upper);
    const hitLower = readCachedIdl(lower);
    const hitBare = readCachedIdl(bare);

    expect(hitUpper?.idl).toBe(hitLower?.idl);
    expect(hitLower?.idl).toBe(hitBare?.idl);
  });

  it('overwrite replaces the previous entry', () => {
    writeCachedIdl(codeIdA, 'original', meta);
    writeCachedIdl(codeIdA, 'replaced', { ...meta, source: 'import' });

    const hit = readCachedIdl(codeIdA);
    expect(hit?.idl).toBe('replaced');
    expect(hit?.meta.source).toBe('import');
  });

  it('write creates parent dir with mode 0700 and files with mode 0600', () => {
    const codeIdB = 'bb'.repeat(32);
    // Remove cache dir if any prior test left it.
    fs.rmSync(getIdlCacheDir(), { recursive: true, force: true });

    writeCachedIdl(codeIdB, 'x', meta);
    expect(mode(getIdlCacheDir())).toBe('700');
    const file = path.join(getIdlCacheDir(), `${codeIdB}.cache.json`);
    expect(mode(file)).toBe('600');
  });

  it('read miss returns null with no error', () => {
    const missing = 'f'.repeat(64);
    expect(readCachedIdl(missing)).toBeNull();
  });

  it('read on a malformed JSON entry returns null (no throw)', () => {
    const codeIdC = 'cc'.repeat(32);
    const file = path.join(getIdlCacheDir(), `${codeIdC}.cache.json`);
    fs.mkdirSync(getIdlCacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, '{ not: valid json', { mode: 0o600 });
    expect(readCachedIdl(codeIdC)).toBeNull();
  });

  it('read on an entry missing the idl field returns null', () => {
    const codeIdD = 'dd'.repeat(32);
    const file = path.join(getIdlCacheDir(), `${codeIdD}.cache.json`);
    fs.mkdirSync(getIdlCacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ meta }), { mode: 0o600 });
    expect(readCachedIdl(codeIdD)).toBeNull();
  });

  it('evict removes the entry; subsequent read returns null', () => {
    const codeIdE = 'ee'.repeat(32);
    writeCachedIdl(codeIdE, 'x', meta);
    expect(readCachedIdl(codeIdE)).not.toBeNull();

    evictCachedIdl(codeIdE);
    expect(readCachedIdl(codeIdE)).toBeNull();
  });

  it('evict on missing entry is a no-op (does not throw)', () => {
    const never = '9'.repeat(64);
    expect(() => evictCachedIdl(never)).not.toThrow();
  });

  it('atomic write leaves no .tmp sibling on success', () => {
    const codeIdF = 'ff'.repeat(32);
    writeCachedIdl(codeIdF, 'x', meta);
    const baseName = `${codeIdF}.cache.json`;
    const leftover = fs.readdirSync(getIdlCacheDir())
      .filter((f) => f.startsWith(baseName + '.') && f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });
});
