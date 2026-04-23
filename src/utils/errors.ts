/**
 * Extract a string message from anything that might be thrown. Preferred
 * over inline `err instanceof Error ? err.message : String(err)` so error
 * formatting stays consistent across the codebase.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ErrorMeta = Record<string, unknown>;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly meta?: ErrorMeta,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function outputError(error: unknown): void {
  const formatted = formatError(error);
  process.stderr.write(JSON.stringify(formatted) + '\n');
}

export function formatError(error: unknown): { error: string; code: string } & ErrorMeta {
  if (error instanceof CliError) {
    const base: { error: string; code: string } & ErrorMeta = {
      error: error.message,
      code: error.code,
    };
    if (error.meta) {
      return { ...base, ...error.meta };
    }
    return base;
  }

  if (error instanceof Error) {
    const message = sanitizeErrorMessage(error.message);
    return { error: message, code: classifyError(error) };
  }

  const msg = typeof error === 'object' && error !== null
    ? JSON.stringify(error)
    : String(error);
  return { error: msg, code: 'UNKNOWN_ERROR' };
}

function sanitizeErrorMessage(message: string): string {
  // Never include seeds or mnemonics in error output
  return message
    .replace(/\/\/\w+/g, '//***')
    .replace(/\b(\w+\s+){11,}\w+\b/g, '***mnemonic***')
    .replace(/0x[a-fA-F0-9]{64,}/g, '0x***');
}

function classifyError(error: Error): string {
  const msg = error.message.toLowerCase();

  if (msg.includes('connect') || msg.includes('websocket') || msg.includes('econnrefused')) {
    return 'CONNECTION_FAILED';
  }
  if (msg.includes('disconnected') || msg.includes('connection lost')) {
    return 'DISCONNECTED';
  }
  if (msg.includes('timeout')) {
    return 'TIMEOUT';
  }
  if (msg.includes('enoent') || msg.includes('not found') || msg.includes('no such file')) {
    return 'NOT_FOUND';
  }
  if (msg.includes('eacces') || msg.includes('permission')) {
    return 'PERMISSION_DENIED';
  }
  if (msg.includes('enospc')) {
    return 'DISK_FULL';
  }

  return 'INTERNAL_ERROR';
}

/**
 * Classify an error thrown from the program execution path (Sails query or
 * function call) into a `PROGRAM_ERROR` CliError with a structured `reason`
 * subcode. Lets agent consumers distinguish program panics from inactive
 * programs from not-found from unreachable code, without regex-matching
 * English panic strings on the consumer side.
 *
 * Always returns code `PROGRAM_ERROR` for backward compatibility. The
 * subcode lives in `meta.reason` (and `meta.programMessage` for panics).
 */
export function classifyProgramError(err: unknown): CliError {
  const raw = err instanceof Error
    ? err.message
    : typeof err === 'object' && err !== null
      ? JSON.stringify(err)
      : String(err);

  // panicked with '<msg>' — capture inner panic string
  const panicMatch = raw.match(/panicked with ['"]([^'"]*)['"]/);
  if (panicMatch) {
    return new CliError(
      `Program execution failed: ${raw}`,
      'PROGRAM_ERROR',
      { reason: 'panic', programMessage: panicMatch[1] },
    );
  }

  if (raw.includes('entered unreachable code')) {
    return new CliError(
      `Program execution failed: ${raw}`,
      'PROGRAM_ERROR',
      { reason: 'unreachable' },
    );
  }

  if (raw.includes('InactiveProgram')) {
    return new CliError(
      `Program execution failed: ${raw}`,
      'PROGRAM_ERROR',
      { reason: 'inactive' },
    );
  }

  if (raw.includes('ProgramNotFound') || raw.includes('does not exist')) {
    return new CliError(
      `Program execution failed: ${raw}`,
      'PROGRAM_ERROR',
      { reason: 'not_found' },
    );
  }

  return new CliError(`Program execution failed: ${raw}`, 'PROGRAM_ERROR');
}

export function installGlobalErrorHandler(): void {
  // Lazy import to avoid circular dependency
  const getShutdownStatus = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../services/api').isShuttingDown();
    } catch {
      return false;
    }
  };

  process.on('uncaughtException', (error) => {
    if (getShutdownStatus()) return;
    outputError(error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (getShutdownStatus()) return;
    outputError(reason);
    process.exit(1);
  });
}
