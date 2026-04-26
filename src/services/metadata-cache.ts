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
const KEY_REGEX = /^0x[0-9a-f]+-\d+$/;

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

/**
 * Read every cache entry into a `{ key: hex }` map suitable for passing
 * directly to `GearApi.create({ metadata: ... })`. A read error on any
 * single entry is logged via verbose() and that entry is skipped.
 */
export function loadMetadataCache(): Record<string, HexString> {
  const dir = getMetadataCacheDir();
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, HexString> = {};
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    verbose(`metadata-cache: failed to list ${dir}: ${errorMessage(err)}`);
    return {};
  }
  for (const f of files) {
    if (!f.endsWith('.hex')) continue;
    const key = f.slice(0, -'.hex'.length);
    if (!KEY_REGEX.test(key)) continue;
    const fullPath = path.join(dir, f);
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8').trim();
      // Lowercase only the prefix slice — `raw` is a 1-3MB hex blob, and
      // `.toLowerCase()` on the full string would allocate a second copy
      // just to inspect 10 chars.
      if (raw.substring(0, METADATA_MAGIC_PREFIX.length).toLowerCase() !== METADATA_MAGIC_PREFIX) {
        // Corrupt or truncated entry. Silently dropping it lets the next
        // call refetch + overwrite. Best-effort unlink so the broken file
        // does not keep tripping verbose logs forever.
        verbose(`metadata-cache: dropping corrupt entry ${f} (bad magic prefix)`);
        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        continue;
      }
      out[key] = raw as HexString;
    } catch (err) {
      verbose(`metadata-cache: skip ${f}: ${errorMessage(err)}`);
    }
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
  let metadataHex: HexString;
  try {
    const genesisHash = api.genesisHash.toHex();
    const specVersion = api.runtimeVersion.specVersion.toString();
    key = buildCacheKey(genesisHash, specVersion);
    metadataHex = api.runtimeMetadata.toHex() as HexString;
  } catch (err) {
    verbose(`metadata-cache: cannot read runtime info: ${errorMessage(err)}`);
    return;
  }
  const filePath = getEntryPath(key);
  if (fs.existsSync(filePath)) {
    pruneCache(api.genesisHash.toHex());
    return;
  }
  try {
    writeUserFileAtomic(filePath, metadataHex);
    verbose(`metadata-cache: wrote ${key} (${metadataHex.length} chars)`);
  } catch (err) {
    verbose(`metadata-cache: write failed for ${key}: ${errorMessage(err)}`);
  }
  pruneCache(api.genesisHash.toHex());
}

/**
 * Keep the `MAX_ENTRIES_PER_CHAIN` most-recently-modified entries for
 * the given `genesisHash`. Older entries get unlinked. Other chains'
 * entries are untouched.
 *
 * Eviction by mtime, not specVersion, so a manual `idl import`-style
 * direct write or a clock-skew issue doesn't permanently strand entries.
 */
export function pruneCache(genesisHash: string): void {
  const dir = getMetadataCacheDir();
  if (!fs.existsSync(dir)) return;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${genesisHash}-`;
  const candidates = files
    .filter((f) => f.startsWith(prefix) && f.endsWith('.hex'))
    .map((f) => {
      const fullPath = path.join(dir, f);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        // unreadable entry — leave at mtime 0 so it sorts as oldest
      }
      return { fullPath, mtimeMs };
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
  const dir = getMetadataCacheDir();
  if (!fs.existsSync(dir)) return { removed: 0 };
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.hex')) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    } catch {
      // skip
    }
  }
  return { removed };
}

/** List metadata cache entries for `metadata list` ops command. */
export function listMetadataCache(): Array<{ key: string; sizeBytes: number; mtime: string }> {
  const dir = getMetadataCacheDir();
  if (!fs.existsSync(dir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ key: string; sizeBytes: number; mtime: string }> = [];
  for (const f of files) {
    if (!f.endsWith('.hex')) continue;
    const key = f.slice(0, -'.hex'.length);
    try {
      const stat = fs.statSync(path.join(dir, f));
      out.push({ key, sizeBytes: stat.size, mtime: new Date(stat.mtimeMs).toISOString() });
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}
