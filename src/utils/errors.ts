export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function outputError(error: unknown): void {
  const formatted = formatError(error);
  process.stderr.write(JSON.stringify(formatted) + '\n');
}

export function formatError(error: unknown): { error: string; code: string } {
  if (error instanceof CliError) {
    return { error: error.message, code: error.code };
  }

  if (error instanceof Error) {
    const message = sanitizeErrorMessage(error.message);
    return { error: message, code: classifyError(error) };
  }

  return { error: String(error), code: 'UNKNOWN_ERROR' };
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
    outputError(reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
  });
}
