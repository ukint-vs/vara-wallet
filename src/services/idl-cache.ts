import * as fs from 'fs';
import * as path from 'path';
import { verbose, errorMessage } from '../utils';
import { writeUserFileAtomic } from '../utils/secure-file';
import { getConfigDir } from './config';
import type { IdlVersion } from './sails';

/**
 * File-based IDL cache keyed by `codeId` (content-hash-like — changes
 * whenever the program's WASM changes, so staleness is self-correcting).
 *
 * Layout: one JSON file per entry at `~/.vara-wallet/idl-cache/<codeId>.cache.json`
 * containing `{ idl, meta }`. One file (not two) to avoid `.idl`/`.json` skew.
 *
 * IO errors on read are non-fatal by design — a corrupt cache must never
 * block a user's call. The resolver falls through to chain re-fetch, which
 * overwrites the bad entry.
 */

export interface IdlCacheMeta {
  version: IdlVersion;
  source: 'chain' | 'import';
  importedAt: string;
}

interface CacheFile {
  idl: string;
  meta: IdlCacheMeta;
}

export function getIdlCacheDir(): string {
  return path.join(getConfigDir(), 'idl-cache');
}

/** Strip 0x prefix and lowercase so `0xABC...` and `abc...` collapse to one entry. */
function normalizeCodeId(codeId: string): string {
  return codeId.replace(/^0x/i, '').toLowerCase();
}

/** Canonical cache filename for a given codeId. Exported so callers (e.g.
 *  the `idl import` command) can echo the written path without re-deriving
 *  it and risking divergence. */
export function getIdlEntryPath(codeId: string): string {
  return path.join(getIdlCacheDir(), `${normalizeCodeId(codeId)}.cache.json`);
}

/**
 * Returns the cached entry for `codeId`, or `null` on miss or any IO /
 * parse error. Errors are logged via `verbose()` so `--verbose` callers
 * can see why a hit didn't land; quiet callers see a transparent miss.
 */
export function readCachedIdl(codeId: string): CacheFile | null {
  const file = getIdlEntryPath(codeId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      verbose(`IDL cache read failed for ${normalizeCodeId(codeId)}: ${errorMessage(err)}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CacheFile;
    if (!parsed || typeof parsed.idl !== 'string' || !parsed.meta) {
      verbose(`IDL cache entry for ${normalizeCodeId(codeId)} has unexpected shape; ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    verbose(`IDL cache parse failed for ${normalizeCodeId(codeId)}: ${errorMessage(err)}`);
    return null;
  }
}

/**
 * Atomic write — uses tmp + rename so a crash mid-write or two racing
 * invocations never leave a half-written file that a subsequent read
 * would choke on. Content-addressed key makes last-write-wins safe.
 */
export function writeCachedIdl(codeId: string, idl: string, meta: IdlCacheMeta): void {
  const file = getIdlEntryPath(codeId);
  const payload = JSON.stringify({ idl, meta }, null, 2) + '\n';
  writeUserFileAtomic(file, payload);
}

/**
 * Remove a cache entry. Used by the resolver when a `idlValidator` rejects
 * a cached IDL — the entry is poisoned (wrong IDL imported for this codeId)
 * and must be evicted so the bundled/chain fallback gets a chance.
 *
 * Non-existent entries are silently accepted.
 */
export function evictCachedIdl(codeId: string): void {
  const file = getIdlEntryPath(codeId);
  try {
    fs.unlinkSync(file);
    verbose(`IDL cache evicted: ${normalizeCodeId(codeId)}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      verbose(`IDL cache evict failed for ${normalizeCodeId(codeId)}: ${errorMessage(err)}`);
    }
  }
}

/**
 * Summary row for `idl list` and `idl clear` preview. One per cache entry.
 *
 * Forward-compat note: every meta field uses optional chaining at read time
 * so a future writer adding new fields, or an older entry missing one,
 * never crashes the listing.
 */
export interface CacheEntrySummary {
  codeId: string;
  version: IdlVersion | 'unknown';
  source: 'chain' | 'import' | 'unknown';
  importedAt: string | null;
  idlSizeBytes: number;
  /** Present only when the entry's JSON failed to parse / had unexpected shape. */
  error?: 'corrupted';
}

/**
 * Enumerate every entry in the IDL cache directory. Returns `[]` when the
 * directory doesn't exist (fresh install). Per-entry parse errors surface
 * as `{ codeId, error: 'corrupted', ... }` rows so the user can see and
 * `idl remove` them — a single bad file does NOT crash the listing.
 *
 * Permission / IO errors on the directory itself propagate (mapped to a
 * clean error code at the command layer).
 */
export function enumerateCacheEntries(): CacheEntrySummary[] {
  const dir = getIdlCacheDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const out: CacheEntrySummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.cache.json')) continue;
    const codeId = name.slice(0, -'.cache.json'.length);
    const file = path.join(dir, name);
    // Single corrupted-row template — both unparsable JSON (catch) and
    // unexpected-shape JSON (if-branch) surface the same row to the
    // caller, who can `idl remove` either kind by codeId.
    const corruptedRow: CacheEntrySummary = {
      codeId,
      version: 'unknown',
      source: 'unknown',
      importedAt: null,
      idlSizeBytes: 0,
      error: 'corrupted',
    };
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (!parsed || typeof parsed.idl !== 'string') {
        out.push(corruptedRow);
        continue;
      }
      out.push({
        codeId,
        version: parsed.meta?.version ?? 'unknown',
        source: parsed.meta?.source ?? 'unknown',
        importedAt: parsed.meta?.importedAt ?? null,
        idlSizeBytes: Buffer.byteLength(parsed.idl, 'utf-8'),
      });
    } catch {
      out.push(corruptedRow);
    }
  }
  return out;
}
