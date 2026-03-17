import chalk from 'chalk';

interface OutputOptions {
  json?: boolean;
  human?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

let globalOptions: OutputOptions = {};

export function setOutputOptions(options: OutputOptions): void {
  globalOptions = options;
}

function shouldOutputJson(): boolean {
  if (globalOptions.json) return true;
  if (globalOptions.human) return false;
  return !process.stdout.isTTY;
}

export function output(data: unknown): void {
  if (globalOptions.quiet) return;

  if (shouldOutputJson()) {
    process.stdout.write(JSON.stringify(data, bigintReplacer) + '\n');
  } else {
    process.stdout.write(formatHuman(data) + '\n');
  }
}

export function outputNdjson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, bigintReplacer) + '\n');
}

export function verbose(message: string): void {
  if (!globalOptions.verbose || globalOptions.quiet) return;
  process.stderr.write(chalk.gray(`[verbose] ${message}\n`));
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

function formatHuman(data: unknown, indent = 0): string {
  if (data === null || data === undefined) return 'null';
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'bigint') return String(data);
  if (typeof data === 'boolean') return String(data);

  const prefix = '  '.repeat(indent);

  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)';
    return data.map((item, i) => `${prefix}${i + 1}. ${formatHuman(item, indent + 1)}`).join('\n');
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
    return entries
      .map(([key, val]) => {
        const paddedKey = key.padEnd(maxKeyLen);
        const valStr = typeof val === 'object' && val !== null
          ? '\n' + formatHuman(val, indent + 1)
          : ` ${formatHuman(val)}`;
        return `${prefix}${chalk.bold(paddedKey)}${typeof val === 'object' && val !== null ? '' : ' :'}${valStr}`;
      })
      .join('\n');
  }

  return String(data);
}
