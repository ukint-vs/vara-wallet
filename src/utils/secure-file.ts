import * as fs from 'fs';
import * as path from 'path';

/**
 * Ensure every ancestor of `dir` exists with mode 0o700.
 *
 * `fs.mkdirSync(path, { recursive: true, mode })` only applies `mode` to the
 * deepest directory it creates. If we call it on `~/.vara-wallet/idl-cache/`
 * and `~/.vara-wallet/` does not yet exist, the intermediate directory gets
 * default permissions (0o755 & ~umask), which is too open for secrets. Walk
 * the path top-down and create+chmod each missing segment explicitly.
 */
function ensureSecureDir(dir: string): void {
  if (fs.existsSync(dir)) return;
  const parent = path.dirname(dir);
  // Stop at the filesystem root; anything above the user's config dir is the
  // OS's problem, not ours.
  if (parent !== dir) ensureSecureDir(parent);
  fs.mkdirSync(dir, { mode: 0o700 });
  // Defend against umask stripping the mode bits on mkdir.
  fs.chmodSync(dir, 0o700);
}

/**
 * Write a file under the user's config area with strict permissions:
 * every parent dir 0o700, file 0o600. Non-atomic — callers that need
 * crash/concurrent-writer safety should use `writeUserFileAtomic`.
 */
export function writeUserFile(filePath: string, content: string | Buffer): void {
  ensureSecureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

/**
 * Like `writeUserFile`, but writes to a per-process `.tmp` sibling first and
 * then `renameSync` to the final path. Used for caches where two processes
 * may race or a crash mid-write would leave a half-written file that later
 * reads would choke on.
 *
 * The tmp name includes `process.pid` so two concurrent CLI invocations that
 * target the same entry don't clobber each other's in-flight tmp files. Only
 * the final rename races, and rename-to-same-path is atomic on POSIX.
 */
export function writeUserFileAtomic(filePath: string, content: string | Buffer): void {
  ensureSecureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
