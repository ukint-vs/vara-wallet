import * as fs from 'fs';
import * as path from 'path';
import type { GearApi } from '@gear-js/api';
import { verbose, errorMessage } from '../utils';
import { writeUserFileAtomic } from '../utils/secure-file';
import { getConfigDir } from './config';

/**
 * On-disk runtime metadata cache for `@polkadot/api`.
 *
 * Layout: one file per (genesisHash, specVersion) pair at
 *   `~/.vara-wallet/metadata-cache/<genesisHash>-<specVersion>.hex`
 *
 * `ApiPromise.create({ metadata: Record<string, HexString> })` looks up
 * the runtime metadata by `${genesisHash}-${specVersion}` key. When a
 * matching entry is provided, polkadot/api skips the `state_getMetadata`
 * RPC call entirely (saves ~750ms per cold connect on Vara mainnet).
 *
 * Auto-invalidation is built into polkadot/api: it subscribes to runtime
 * version changes and refetches on a spec bump, so a stale cache for an
 * older spec version is never silently used — the lookup just misses
 * for the current key.
 *
 * IO errors on read are non-fatal — same posture as `idl-cache.ts`. A
 * corrupt entry must never block a user's call. The wire-up at api.ts
 * passes whatever loads to polkadot/api; if a specific entry is broken,
 * polkadot/api throws when wrapping it as Metadata, and we fall through
 * to fresh fetch which overwrites the bad entry on the next save.
 */

export type HexString = `0x${string}`;
const ENTRY_REGEX = /^(0x[0-9a-f]+-\d+)\.hex$/;

/** Substrate runtime metadata SCALE encoding starts with the bytes "meta"
 *  (0x6d657461). Any cached file not starting with this prefix is corrupt
 *  or truncated and would crash @polkadot/api's init with a fatal
 *  MagicNumber mismatch. We drop such entries on load. */
const METADATA_MAGIC_PREFIX = '0x6d657461';

/** Eviction policy: keep this many most-recently-used entries per genesisHash.
 *  Vara runtime upgrades roughly monthly; 3 entries cover ~3 months of warm
 *  hits across upgrades. Total disk: 3 × ~1-3MB = ~3-9MB per chain. */
const MAX_ENTRIES_PER_CHAIN = 3;

export function getMetadataCacheDir(): string {
  return path.join(getConfigDir(), 'metadata-cache');
}

function getEntryPath(key: string): string {
  return path.join(getMetadataCacheDir(), `${key}.hex`);
}

/** Compute the cache key polkadot/api uses to look up metadata. */
export function buildCacheKey(genesisHash: string, specVersion: number | string): string {
  return `${genesisHash}-${specVersion}`;
}

interface EntryRef {
  key: string;
  fullPath: string;
}

/**
 * Single readdir + key-shape filter for every disk-walking caller in this
 * module (load / list / clear / prune). Mirrors `idl-cache.ts`'s
 * `enumerateCacheEntries` posture: ENOENT → empty list, real IO errors
 * (EACCES, EIO) propagate to verbose() and yield empty rather than
 * silently masking permission problems.
 */
function enumerateEntries(): EntryRef[] {
  const dir = getMetadataCacheDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    verbose(`metadata-cache: failed to list ${dir}: ${errorMessage(err)}`);
    return [];
  }
  const out: EntryRef[] = [];
  for (const name of names) {
    const m = ENTRY_REGEX.exec(name);
    if (!m) continue;
    out.push({ key: m[1], fullPath: path.join(dir, name) });
  }
  return out;
}

/**
 * Validate the metadata magic prefix without reading the whole file.
 * Cache files are 1-3MB; loading the full hex into memory just to check
 * 10 chars wastes ~6MB of allocation across 3 entries on every connect.
 * Returns false (and best-effort unlinks the file) for corrupt entries.
 */
function readEntryIfValid(fullPath: string, name: string): HexString | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(METADATA_MAGIC_PREFIX.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, n).toString('utf-8').toLowerCase();
    if (head !== METADATA_MAGIC_PREFIX) {
      verbose(`metadata-cache: dropping corrupt entry ${name} (bad magic prefix)`);
      try { fs.unlinkSync(fullPath); } catch { /* unlink is best-effort */ }
      return null;
    }
  } catch (err) {
    verbose(`metadata-cache: skip ${name}: ${errorMessage(err)}`);
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fd close errors are non-fatal */ }
    }
  }
  try {
    return fs.readFileSync(fullPath, 'utf-8').trim() as HexString;
  } catch (err) {
    verbose(`metadata-cache: read failed for ${name}: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Read every cache entry into a `{ key: hex }` map suitable for passing
 * directly to `GearApi.create({ metadata: ... })`. A read error on any
 * single entry is logged via verbose() and that entry is skipped.
 */
export function loadMetadataCache(): Record<string, HexString> {
  const out: Record<string, HexString> = {};
  for (const { key, fullPath } of enumerateEntries()) {
    const hex = readEntryIfValid(fullPath, path.basename(fullPath));
    if (hex) out[key] = hex;
  }
  return out;
}

/**
 * After a successful `GearApi.create()`, write the active runtime metadata
 * to the cache if the current `(genesisHash, specVersion)` key isn't
 * already present. Idempotent — does nothing if the entry already exists.
 *
 * Also runs `pruneCache()` to enforce the per-chain eviction cap.
 */
export function saveMetadataIfNew(api: GearApi): void {
  let key: string;
  let genesisHash: string;
  let metadataHex: HexString;
  try {
    genesisHash = api.genesisHash.toHex();
    const specVersion = api.runtimeVersion.specVersion.toString();
    key = buildCacheKey(genesisHash, specVersion);
    metadataHex = api.runtimeMetadata.toHex() as HexString;
  } catch (err) {
    verbose(`metadata-cache: cannot read runtime info: ${errorMessage(err)}`);
    return;
  }
  const filePath = getEntryPath(key);
  // Operate-and-catch beats existsSync (avoids a TOCTOU race + extra syscall).
  // ENOENT is the success path — entry is missing, we proceed to write.
  try {
    fs.statSync(filePath);
    // Entry exists. Nothing to write; pruning isn't needed either since
    // we didn't grow the set.
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      verbose(`metadata-cache: stat failed for ${key}: ${errorMessage(err)}`);
      return;
    }
  }
  try {
    writeUserFileAtomic(filePath, metadataHex);
    verbose(`metadata-cache: wrote ${key} (${metadataHex.length} chars)`);
  } catch (err) {
    verbose(`metadata-cache: write failed for ${key}: ${errorMessage(err)}`);
    return;
  }
  pruneCache(genesisHash);
}

/**
 * Keep the `MAX_ENTRIES_PER_CHAIN` most-recently-modified entries for
 * the given `genesisHash`. Older entries get unlinked. Other chains'
 * entries are untouched.
 *
 * Eviction by mtime, not specVersion, so a manual direct write or a
 * clock-skew issue doesn't permanently strand entries.
 */
export function pruneCache(genesisHash: string): void {
  const prefix = `${genesisHash}-`;
  const candidates = enumerateEntries()
    .filter((e) => e.key.startsWith(prefix))
    .map((e) => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(e.fullPath).mtimeMs;
      } catch {
        // unreadable entry — leave at mtime 0 so it sorts as oldest
      }
      return { ...e, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of candidates.slice(MAX_ENTRIES_PER_CHAIN)) {
    try {
      fs.unlinkSync(stale.fullPath);
      verbose(`metadata-cache: evicted ${path.basename(stale.fullPath)}`);
    } catch (err) {
      verbose(`metadata-cache: evict failed for ${stale.fullPath}: ${errorMessage(err)}`);
    }
  }
}

/**
 * Remove every metadata cache entry. Used by the `metadata clear`
 * command. Errors are non-fatal — best-effort cleanup.
 */
export function clearMetadataCache(): { removed: number } {
  let removed = 0;
  for (const { fullPath } of enumerateEntries()) {
    try {
      fs.unlinkSync(fullPath);
      removed++;
    } catch (err) {
      verbose(`metadata-cache: unlink failed for ${fullPath}: ${errorMessage(err)}`);
    }
  }
  return { removed };
}

/** List metadata cache entries for `metadata list` ops command. */
export function listMetadataCache(): Array<{ key: string; sizeBytes: number; mtime: string }> {
  const out: Array<{ key: string; sizeBytes: number; mtime: string }> = [];
  for (const { key, fullPath } of enumerateEntries()) {
    try {
      const stat = fs.statSync(fullPath);
      out.push({ key, sizeBytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
    } catch (err) {
      verbose(`metadata-cache: stat failed for ${fullPath}: ${errorMessage(err)}`);
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}
