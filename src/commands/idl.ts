import { Command } from 'commander';
import * as fs from 'fs';
import { getApi } from '../services/api';
import {
  writeCachedIdl,
  getIdlEntryPath,
  getIdlCacheDir,
  enumerateCacheEntries,
  evictCachedIdl,
} from '../services/idl-cache';
import { detectIdlVersion } from '../services/sails';
import { output, verbose, CliError, addressToHex, errorMessage } from '../utils';

/** Strict 32-byte hex (with or without 0x prefix). Reused across idl
 *  import/remove so the codeId vocabulary is identical. */
const CODE_ID_HEX_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * `vara-wallet idl import <path.idl> (--code-id <hex> | --program <hex|ss58>)`
 *
 * Seed the local IDL cache for a program whose IDL is not auto-discoverable
 * from the chain (v1 programs, or programs built with sails < 1.0.0-beta.1).
 * Once imported, `vara-wallet call/discover/vft/dex` can reach the IDL
 * without any further flags.
 *
 * `--code-id` is fully offline; `--program` resolves `codeId` via RPC first.
 * Exactly one must be provided.
 *
 * Validation happens lazily — we do NOT run `idlValidator` at import time
 * because validators are caller-specific (vft wants `BalanceOf`, dex wants
 * `GetPair`). The resolver gates cache reads against the validator when the
 * caller supplies one, evicting mismatches on the fly.
 */
export function registerIdlCommand(program: Command): void {
  const idl = program.command('idl').description('IDL cache management');

  idl
    .command('import')
    .description('Import an IDL into the local cache for a codeId')
    .argument('<path>', 'path to .idl file')
    .option('--code-id <hex>', 'code ID (0x...) — offline; no RPC call')
    .option('--program <hex|ss58>', 'program ID — resolves codeId via RPC')
    .action(async (idlPath: string, options: { codeId?: string; program?: string }) => {
      // Exactly one of --code-id or --program.
      if (!!options.codeId === !!options.program) {
        throw new CliError(
          'Provide exactly one of --code-id <hex> or --program <hex|ss58>.',
          'INVALID_ARGS',
        );
      }

      // Read IDL file.
      let idlText: string;
      try {
        idlText = fs.readFileSync(idlPath, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new CliError(`IDL file not found: ${idlPath}`, 'IDL_FILE_NOT_FOUND');
        }
        throw new CliError(`Failed to read IDL file: ${idlPath}`, 'IDL_FILE_ERROR');
      }

      const version = detectIdlVersion(idlText);
      verbose(`Detected IDL version: ${version}`);

      // Resolve codeId.
      let codeId: string;
      if (options.codeId) {
        // User-supplied codeId is untrusted — validate strict 32-byte hex before
        // it hits the cache filename. Without this, `--code-id "../../etc/foo"`
        // would escape the cache directory (mode 0600 on the file, but outside
        // ~/.vara-wallet/idl-cache/ — still a path-traversal surface).
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(options.codeId)) {
          throw new CliError(
            `Invalid --code-id: expected 32-byte hex string (0x-prefixed or bare), got "${options.codeId}"`,
            'INVALID_CODE_ID',
          );
        }
        codeId = options.codeId;
      } else {
        const opts = program.optsWithGlobals() as { ws?: string };
        const api = await getApi(opts.ws);
        const programHex = addressToHex(options.program!);
        verbose(`Resolving codeId for program ${programHex}...`);
        codeId = await api.program.codeId(programHex);
        verbose(`Program codeId: ${codeId}`);
      }

      writeCachedIdl(codeId, idlText, {
        version,
        source: 'import',
        importedAt: new Date().toISOString(),
      });

      output({
        codeId,
        version,
        source: 'import',
        path: getIdlEntryPath(codeId),
      });
    });

  // ───────────── idl list ─────────────
  idl
    .command('list')
    .description('List cached IDL entries')
    .action(() => {
      output(enumerateCacheEntries());
    });

  // ───────────── idl remove <code-id> ─────────────
  idl
    .command('remove')
    .description('Remove a single cached IDL entry (idempotent — non-existent entries return removed: false, exit 0)')
    .argument('<code-id>', 'code ID (0x-prefixed or bare 32-byte hex)')
    .action((codeId: string) => {
      if (!CODE_ID_HEX_RE.test(codeId)) {
        throw new CliError(
          `Invalid <code-id>: expected 32-byte hex (0x-prefixed or bare), got "${codeId}"`,
          'INVALID_CODE_ID',
        );
      }
      const file = getIdlEntryPath(codeId);
      const existed = fs.existsSync(file);
      // evictCachedIdl already swallows ENOENT and verbose-logs other errors.
      evictCachedIdl(codeId);
      output({ codeId, removed: existed });
    });

  // ───────────── idl clear [--yes] ─────────────
  // terraform-style: bare invocation previews; --yes commits.
  idl
    .command('clear')
    .description('Remove all cached IDL entries (terraform-style: bare invocation previews; --yes commits)')
    .option('--yes', 'actually remove the entries (without --yes, only previews what would be removed)')
    .action((options: { yes?: boolean }) => {
      const dir = getIdlCacheDir();
      // Snapshot — single readdir at the top. New entries created by a
      // parallel writer between snapshot and unlink will simply survive
      // until the next clear (recoverable resource, no locking).
      const entries = enumerateCacheEntries();

      if (!options.yes) {
        output({
          wouldRemove: entries.map((e) => ({ codeId: e.codeId, source: e.source })),
          path: dir,
          hint: 'vara-wallet idl clear --yes to proceed',
        });
        return;
      }

      let removed = 0;
      for (const entry of entries) {
        // Reuse getIdlEntryPath so the cache filename schema is single-sourced
        // in idl-cache.ts (was: inline `${codeId}.cache.json` template).
        const file = getIdlEntryPath(entry.codeId);
        try {
          fs.unlinkSync(file);
          removed++;
          verbose(`IDL cache entry removed: ${entry.codeId}`);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') continue; // race: removed between snapshot and unlink
          if (code === 'EACCES') {
            throw new CliError(
              `Permission denied removing IDL cache entry ${entry.codeId}: ${errorMessage(err)}`,
              'PERMISSION_DENIED',
            );
          }
          throw err;
        }
      }
      output({ removed, path: dir });
    });
}
