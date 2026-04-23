import * as fs from 'fs';
import * as path from 'path';

/**
 * Write a file under the user's config area with strict permissions:
 * parent directory 0o700, file 0o600. Non-atomic — callers that need
 * crash/concurrent-writer safety should use `writeUserFileAtomic`.
 */
export function writeUserFile(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

/**
 * Like `writeUserFile`, but writes to `<path>.tmp` first and then
 * `renameSync` to the final path. Used for caches where two processes
 * may race or a crash mid-write would leave a half-written file that
 * later reads would choke on.
 *
 * rename(2) is atomic on POSIX within the same filesystem — both tmp
 * and final live in the same directory, so this holds.
 */
export function writeUserFileAtomic(filePath: string, content: string | Buffer): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
