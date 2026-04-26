import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Redirect VARA_WALLET_DIR before importing the module under test so the
// cache lands under a throwaway directory.
const testDir = path.join(os.tmpdir(), `vara-metadata-cache-test-${Date.now()}-${process.pid}`);
process.env.VARA_WALLET_DIR = testDir;

import {
  loadMetadataCache,
  saveMetadataIfNew,
  pruneCache,
  clearMetadataCache,
  listMetadataCache,
  getMetadataCacheDir,
  buildCacheKey,
} from '../services/metadata-cache';

const GENESIS_A = '0xfe1b4c55fd4d668101126434206571a7838a8b6b93a6d1b95d607e78e6c53763';
const GENESIS_B = '0x011fee1bdc7a26395a89bf90c93b22cee47e15d2db58cc6c8eddee0395bcb3a8';

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function mode(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

/**
 * Build a minimal mock GearApi-shaped object satisfying the fields
 * `saveMetadataIfNew` reads. The real api builds a Metadata Codec; we
 * only exercise the disk write path, so the hex string is enough.
 */
function mockApi(genesisHash: string, specVersion: number, metadataHex: string) {
  return {
    genesisHash: { toHex: () => genesisHash },
    runtimeVersion: { specVersion: { toString: () => String(specVersion) } },
    runtimeMetadata: { toHex: () => metadataHex },
  } as never;
}

describe('metadata-cache', () => {
  beforeEach(() => {
    // Clean state between tests
    fs.rmSync(getMetadataCacheDir(), { recursive: true, force: true });
  });

  it('round-trips: saveMetadataIfNew then loadMetadataCache returns the same hex', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461deadbeef'));
    const loaded = loadMetadataCache();
    const key = buildCacheKey(GENESIS_A, 11000);
    expect(loaded[key]).toBe('0x6d657461deadbeef');
  });

  it('written file uses 0o600 mode', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461deadbeef'));
    const filePath = path.join(getMetadataCacheDir(), `${buildCacheKey(GENESIS_A, 11000)}.hex`);
    expect(mode(filePath)).toBe('600');
  });

  it('saveMetadataIfNew is idempotent when entry exists', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461first'));
    const filePath = path.join(getMetadataCacheDir(), `${buildCacheKey(GENESIS_A, 11000)}.hex`);
    const mtimeFirst = fs.statSync(filePath).mtimeMs;
    // Calling again with different content must NOT overwrite — the
    // contract is "key matches, skip write" so a stale-but-still-valid
    // entry survives.
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461second'));
    const stat = fs.statSync(filePath);
    expect(stat.mtimeMs).toBe(mtimeFirst);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('0x6d657461first');
  });

  it('different specVersion creates a separate entry', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461aa'));
    saveMetadataIfNew(mockApi(GENESIS_A, 11001, '0x6d657461bb'));
    const loaded = loadMetadataCache();
    expect(loaded[buildCacheKey(GENESIS_A, 11000)]).toBe('0x6d657461aa');
    expect(loaded[buildCacheKey(GENESIS_A, 11001)]).toBe('0x6d657461bb');
  });

  it('different genesisHash creates a separate entry (testnet vs mainnet)', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461aa'));
    saveMetadataIfNew(mockApi(GENESIS_B, 11000, '0x6d657461bb'));
    const loaded = loadMetadataCache();
    expect(Object.keys(loaded)).toHaveLength(2);
    expect(loaded[buildCacheKey(GENESIS_A, 11000)]).toBe('0x6d657461aa');
    expect(loaded[buildCacheKey(GENESIS_B, 11000)]).toBe('0x6d657461bb');
  });

  it('pruneCache keeps the 3 most-recent entries per genesisHash', async () => {
    // Write 5 entries with distinct mtimes
    for (let i = 0; i < 5; i++) {
      saveMetadataIfNew(mockApi(GENESIS_A, 11000 + i, `0x6d6574610${i}`));
      // Force visible mtime separation
      await new Promise((r) => setTimeout(r, 5));
    }
    // After saving 5 entries, the prune-on-write should leave only 3.
    // (Each saveMetadataIfNew calls pruneCache.)
    const remaining = fs.readdirSync(getMetadataCacheDir())
      .filter((f) => f.startsWith(GENESIS_A))
      .sort();
    expect(remaining).toHaveLength(3);
    // The 3 newest spec versions (11002, 11003, 11004) should survive
    expect(remaining.some((f) => f.includes('-11004'))).toBe(true);
    expect(remaining.some((f) => f.includes('-11003'))).toBe(true);
    expect(remaining.some((f) => f.includes('-11002'))).toBe(true);
  });

  it('pruneCache scoped per-chain (does not evict other genesisHashes)', async () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 1, '0x6d657461a1'));
    saveMetadataIfNew(mockApi(GENESIS_B, 1, '0x6d657461b1'));
    saveMetadataIfNew(mockApi(GENESIS_B, 2, '0x6d657461b2'));
    saveMetadataIfNew(mockApi(GENESIS_B, 3, '0x6d657461b3'));
    saveMetadataIfNew(mockApi(GENESIS_B, 4, '0x6d657461b4'));
    // GENESIS_B should be capped at 3, GENESIS_A untouched.
    const all = fs.readdirSync(getMetadataCacheDir());
    expect(all.filter((f) => f.startsWith(GENESIS_A))).toHaveLength(1);
    expect(all.filter((f) => f.startsWith(GENESIS_B))).toHaveLength(3);
  });

  it('loadMetadataCache returns empty record when dir does not exist', () => {
    expect(loadMetadataCache()).toEqual({});
  });

  it('loadMetadataCache skips files that fail key-format validation', () => {
    fs.mkdirSync(getMetadataCacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(getMetadataCacheDir(), 'not-a-valid-key.hex'), '0xabc');
    fs.writeFileSync(path.join(getMetadataCacheDir(), '../../escape.hex'), '0xevil');
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0x6d657461good'));
    const loaded = loadMetadataCache();
    expect(Object.keys(loaded)).toEqual([buildCacheKey(GENESIS_A, 11000)]);
  });

  it('loadMetadataCache drops entries with bad metadata magic prefix', () => {
    // Write a syntactically-valid key but content that polkadot/api would
    // reject (wrong magic). loadMetadataCache must drop it, not pass through.
    // This is the defense against the "Unable to initialize the API: MagicNumber
    // mismatch" crash that would otherwise hit on every connect.
    fs.mkdirSync(getMetadataCacheDir(), { recursive: true, mode: 0o700 });
    const validKey = buildCacheKey(GENESIS_A, 11000);
    const filePath = path.join(getMetadataCacheDir(), `${validKey}.hex`);
    fs.writeFileSync(filePath, '0xdeadbeef'); // valid hex, but no `meta` magic
    expect(loadMetadataCache()).toEqual({});
    // Best-effort cleanup: corrupt entry should be unlinked so it
    // does not keep tripping verbose logs forever.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('loadMetadataCache skips entries that do not start with 0x', () => {
    fs.mkdirSync(getMetadataCacheDir(), { recursive: true, mode: 0o700 });
    const validKey = buildCacheKey(GENESIS_A, 11000);
    fs.writeFileSync(path.join(getMetadataCacheDir(), `${validKey}.hex`), 'not-hex-content');
    expect(loadMetadataCache()).toEqual({});
  });

  it('clearMetadataCache removes all entries and reports count', () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0xa'));
    saveMetadataIfNew(mockApi(GENESIS_B, 11000, '0xb'));
    expect(clearMetadataCache().removed).toBe(2);
    expect(loadMetadataCache()).toEqual({});
  });

  it('clearMetadataCache on missing dir returns 0 without throwing', () => {
    expect(clearMetadataCache().removed).toBe(0);
  });

  it('listMetadataCache returns entries sorted by mtime descending', async () => {
    saveMetadataIfNew(mockApi(GENESIS_A, 11000, '0xa'));
    await new Promise((r) => setTimeout(r, 10));
    saveMetadataIfNew(mockApi(GENESIS_A, 11001, '0xb'));
    const list = listMetadataCache();
    expect(list).toHaveLength(2);
    expect(list[0].key).toBe(buildCacheKey(GENESIS_A, 11001)); // newest first
    expect(list[1].key).toBe(buildCacheKey(GENESIS_A, 11000));
    expect(list[0].sizeBytes).toBeGreaterThan(0);
    expect(list[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  });

  it('buildCacheKey produces the format polkadot/api expects', () => {
    expect(buildCacheKey(GENESIS_A, 11000)).toBe(`${GENESIS_A}-11000`);
    expect(buildCacheKey(GENESIS_A, '11000')).toBe(`${GENESIS_A}-11000`);
  });
});
