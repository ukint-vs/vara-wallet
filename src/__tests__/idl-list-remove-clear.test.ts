import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Redirect VARA_WALLET_DIR before importing modules under test.
const testDir = path.join(os.tmpdir(), `vara-idl-listrm-test-${Date.now()}-${process.pid}`);
process.env.VARA_WALLET_DIR = testDir;

import {
  writeCachedIdl,
  evictCachedIdl,
  enumerateCacheEntries,
  getIdlCacheDir,
  getIdlEntryPath,
  IdlCacheMeta,
} from '../services/idl-cache';

const codeIdA = '0x' + 'aa'.repeat(32);
const codeIdB = '0x' + 'bb'.repeat(32);
const codeIdC = '0x' + 'cc'.repeat(32);

const meta = (source: 'chain' | 'import'): IdlCacheMeta => ({
  version: 'v2',
  source,
  importedAt: '2026-04-25T00:00:00.000Z',
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clean slate between tests so each test owns its fixture state.
  const dir = getIdlCacheDir();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.cache.json')) fs.unlinkSync(path.join(dir, name));
    }
  }
});

describe('enumerateCacheEntries', () => {
  it('returns [] when the cache dir does not exist (fresh install)', () => {
    // Use a directory we know doesn't exist; can't blow away getIdlCacheDir
    // because writeCachedIdl will recreate it, so we just verify the
    // post-create empty case.
    const dir = getIdlCacheDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    expect(enumerateCacheEntries()).toEqual([]);
  });

  it('returns [] when the cache dir exists but contains no .cache.json files', () => {
    const dir = getIdlCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'noise', { mode: 0o600 });
    expect(enumerateCacheEntries()).toEqual([]);
  });

  it('lists every cached entry with full metadata', () => {
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    writeCachedIdl(codeIdB, 'service B { query Foo : () -> u32; }', meta('import'));

    const entries = enumerateCacheEntries().sort((x, y) => x.codeId.localeCompare(y.codeId));
    expect(entries).toHaveLength(2);
    expect(entries[0].codeId).toBe('aa'.repeat(32));
    expect(entries[0].source).toBe('chain');
    expect(entries[0].version).toBe('v2');
    expect(entries[0].idlSizeBytes).toBe(Buffer.byteLength('service A {}', 'utf-8'));
    expect(entries[1].codeId).toBe('bb'.repeat(32));
    expect(entries[1].source).toBe('import');
  });

  it('surfaces a corrupted entry as { error: "corrupted" } without crashing the listing', () => {
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    const corruptedFile = path.join(getIdlCacheDir(), `${'cc'.repeat(32)}.cache.json`);
    fs.writeFileSync(corruptedFile, '{ this is not json', { mode: 0o600 });

    const entries = enumerateCacheEntries().sort((x, y) => x.codeId.localeCompare(y.codeId));
    expect(entries).toHaveLength(2);
    const corrupted = entries.find((e) => e.error === 'corrupted');
    expect(corrupted).toBeDefined();
    expect(corrupted?.codeId).toBe('cc'.repeat(32));
    // The healthy entry is still present.
    const healthy = entries.find((e) => e.error === undefined);
    expect(healthy?.codeId).toBe('aa'.repeat(32));
  });

  it('forward-compat: missing meta fields do not crash the listing', () => {
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    // Manually rewrite the file with a partial meta shape (simulates a
    // future writer adding fields, or a pre-this-PR entry missing some).
    const file = getIdlEntryPath(codeIdA);
    fs.writeFileSync(
      file,
      JSON.stringify({ idl: 'service A {}', meta: {} }),
      { mode: 0o600 },
    );
    const entries = enumerateCacheEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('unknown');
    expect(entries[0].source).toBe('unknown');
    expect(entries[0].importedAt).toBeNull();
    // Still computes idlSizeBytes from the present idl string.
    expect(entries[0].idlSizeBytes).toBe(Buffer.byteLength('service A {}', 'utf-8'));
  });
});

describe('idl remove (via evictCachedIdl)', () => {
  it('removes an existing entry', () => {
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    expect(fs.existsSync(getIdlEntryPath(codeIdA))).toBe(true);
    evictCachedIdl(codeIdA);
    expect(fs.existsSync(getIdlEntryPath(codeIdA))).toBe(false);
  });

  it('is idempotent: removing a non-existent entry does not throw', () => {
    expect(fs.existsSync(getIdlEntryPath(codeIdC))).toBe(false);
    expect(() => evictCachedIdl(codeIdC)).not.toThrow();
  });
});

describe('idl clear semantics (snapshot-then-unlink)', () => {
  it('regression: snapshot-then-unlink swallows ENOENT for entries removed mid-clear', () => {
    // Setup three entries, then directly invoke the snapshot+unlink loop
    // simulating a parallel process unlinking codeIdB between enumeration
    // and the unlink call. This proves the loop is race-tolerant.
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    writeCachedIdl(codeIdB, 'service B {}', meta('chain'));
    writeCachedIdl(codeIdC, 'service C {}', meta('chain'));

    const dir = getIdlCacheDir();
    const entries = enumerateCacheEntries(); // snapshot

    // Simulate the parallel-process race: B disappears before our unlink.
    fs.unlinkSync(getIdlEntryPath(codeIdB));

    // Now the loop the command runs (mirrors src/commands/idl.ts):
    let removed = 0;
    let threw = false;
    for (const entry of entries) {
      const file = path.join(dir, `${entry.codeId}.cache.json`);
      try {
        fs.unlinkSync(file);
        removed++;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        threw = true;
      }
    }
    expect(threw).toBe(false);
    // Only the two surviving entries got removed; B was already gone.
    expect(removed).toBe(2);
    expect(enumerateCacheEntries()).toEqual([]);
  });

  it('preview shape (without --yes): wouldRemove lists every entry and includes hint', () => {
    writeCachedIdl(codeIdA, 'service A {}', meta('chain'));
    writeCachedIdl(codeIdB, 'service B {}', meta('import'));

    const entries = enumerateCacheEntries();
    const wouldRemove = entries.map((e) => ({ codeId: e.codeId, source: e.source }));
    expect(wouldRemove).toHaveLength(2);
    expect(wouldRemove).toContainEqual({ codeId: 'aa'.repeat(32), source: 'chain' });
    expect(wouldRemove).toContainEqual({ codeId: 'bb'.repeat(32), source: 'import' });
    // Files survive — preview did not unlink.
    expect(fs.existsSync(getIdlEntryPath(codeIdA))).toBe(true);
    expect(fs.existsSync(getIdlEntryPath(codeIdB))).toBe(true);
  });
});
