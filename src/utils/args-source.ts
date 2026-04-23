/**
 * Resolve `--args` JSON from one of three sources: inline string,
 * file path, or stdin (when path is `-`).
 *
 * Used by `call`, `encode`, and `program upload`/`deploy` to eliminate
 * shell-escape failures when nested JSON (e.g. 64-byte vec u8 signatures)
 * is passed as a CLI flag value. See issue #20.
 *
 * Privacy contract: when JSON parsing fails on a file, the error message
 * MUST NOT echo the file path or the file content beyond a small parser
 * snippet — args files often contain test seeds, mnemonics, and signed
 * payloads.
 */

import * as fs from 'fs';
import { CliError } from './errors';

const MAX_ARGS_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ArgsSourceOptions {
  /** Raw --args JSON string. `undefined` means the user did not pass --args. */
  args?: string;
  /** --args-file value. `'-'` means read from stdin. */
  argsFile?: string;
  /** Default JSON to use when neither flag is supplied. e.g. `'[]'` for `call`. */
  argsDefault?: string;
}

/**
 * Resolve, read, and JSON-parse the args source according to mutual-exclusion
 * and stdin rules. Returns the parsed value (caller wraps non-arrays).
 *
 * Throws CliError with one of:
 *  - INVALID_ARGS_SOURCE   — both --args and --args-file supplied
 *  - STDIN_IS_TTY          — --args-file '-' but stdin is a TTY (no pipe)
 *  - ARGS_FILE_READ_ERROR  — file open/read failed (ENOENT, EACCES, ...)
 *  - ARGS_FILE_TOO_LARGE   — file > 10 MB
 *  - INVALID_ARGS          — empty input or malformed JSON
 */
export function loadArgsJson(opts: ArgsSourceOptions): unknown {
  const hasArgs = opts.args !== undefined;
  const hasFile = opts.argsFile !== undefined;

  if (hasArgs && hasFile) {
    throw new CliError(
      "Cannot use --args and --args-file together; pick one. " +
      "(--args for inline JSON, --args-file for file path or - for stdin)",
      'INVALID_ARGS_SOURCE',
    );
  }

  let raw: string;
  let sourceTag: 'inline' | 'file' | 'stdin' | 'default';

  if (hasFile) {
    const path = opts.argsFile!;
    if (path === '-') {
      sourceTag = 'stdin';
      raw = readStdinSync();
    } else {
      sourceTag = 'file';
      raw = readArgsFile(path);
    }
  } else if (hasArgs) {
    sourceTag = 'inline';
    raw = opts.args!;
  } else if (opts.argsDefault !== undefined) {
    sourceTag = 'default';
    raw = opts.argsDefault;
  } else {
    throw new CliError(
      "No args provided. Use --args <json> or --args-file <path>.",
      'MISSING_ARGS_SOURCE',
    );
  }

  if (raw.length === 0) {
    if (sourceTag === 'stdin') {
      throw new CliError(
        "--args-file '-' received empty input on stdin.",
        'INVALID_ARGS',
      );
    }
    throw new CliError("Empty args input.", 'INVALID_ARGS');
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    // PRIVACY: build a fresh message with only parse-position info.
    // Never include the file path or file content beyond a snippet.
    const syntaxMsg = err instanceof Error ? err.message : String(err);
    // Native JSON.parse SyntaxError messages do NOT include the input
    // string or any path — they look like:
    //   "Unexpected token } in JSON at position 22"
    //   "Expected ',' or ']' after array element in JSON at position 15"
    // Verified across Node 20-24. Safe to forward verbatim.
    const positionMatch = syntaxMsg.match(/at position (\d+)/);
    if (positionMatch) {
      throw new CliError(
        `Failed to parse args JSON at position ${positionMatch[1]}: ${stripPositionTail(syntaxMsg)}`,
        'INVALID_ARGS',
      );
    }
    throw new CliError(
      `Failed to parse args JSON: ${syntaxMsg}`,
      'INVALID_ARGS',
    );
  }
}

/** @internal — test-only seam to fake file size without writing 11 MB to disk. */
let _statSizeOverride: ((path: string) => number | null) | null = null;
export function __setStatSizeOverrideForTests(fn: ((path: string) => number | null) | null): void {
  _statSizeOverride = fn;
}

function readArgsFile(path: string): string {
  let size: number;
  try {
    const overridden = _statSizeOverride?.(path);
    size = overridden ?? fs.statSync(path).size;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to read args file: ${msg}`, 'ARGS_FILE_READ_ERROR');
  }
  if (size > MAX_ARGS_FILE_BYTES) {
    throw new CliError(
      `Args file too large (${size} bytes, max ${MAX_ARGS_FILE_BYTES}).`,
      'ARGS_FILE_TOO_LARGE',
    );
  }
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to read args file: ${msg}`, 'ARGS_FILE_READ_ERROR');
  }
}

/**
 * Test seam — production code MUST NOT override this. The seam exists because
 * Jest cannot reliably spy on `fs.readFileSync` (the export is non-configurable
 * under both ESM and CJS module wrappers in this project).
 *
 * Override only via `__setStdinReaderForTests` from inside test files.
 */
let _stdinReader: () => string = () => fs.readFileSync(0, 'utf-8');

/** @internal — test-only seam */
export function __setStdinReaderForTests(reader: (() => string) | null): void {
  _stdinReader = reader ?? (() => fs.readFileSync(0, 'utf-8'));
}

function readStdinSync(): string {
  // Reject early when stdin is an interactive terminal — otherwise the
  // sync read would block indefinitely waiting for EOF, and AI agents
  // that mistakenly use --args-file - without a pipe would hang.
  if (process.stdin.isTTY) {
    throw new CliError(
      "--args-file '-' requires JSON piped on stdin (got an interactive terminal). " +
      "Pipe the JSON: 'cat args.json | vara-wallet ...'",
      'STDIN_IS_TTY',
    );
  }
  try {
    return _stdinReader();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`Failed to read stdin: ${msg}`, 'ARGS_FILE_READ_ERROR');
  }
}

/**
 * Drop the trailing " in JSON at position N" tail from a SyntaxError
 * message — we surface position separately above. Handles both Node 20
 * (`... at position N`) and Node 22+ (`... at position N (line L column C)`)
 * formats.
 */
function stripPositionTail(msg: string): string {
  return msg.replace(/\s+in JSON at position \d+(?:\s*\(line \d+ column \d+\))?\s*$/, '');
}
