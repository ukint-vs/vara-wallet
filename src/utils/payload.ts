import { CliError } from './errors';

/**
 * Convert UTF-8 text to a 0x-prefixed hex string.
 */
export function textToHex(text: string): string {
  const bytes = Buffer.from(text, 'utf-8');
  return '0x' + bytes.toString('hex');
}

/**
 * Try to decode a hex string as printable ASCII text.
 * Returns undefined if the hex is invalid or contains non-printable bytes.
 *
 * Printable rule: every byte must be 0x20-0x7E (printable ASCII) or 0x0A (newline).
 */
export function tryHexToText(hex: string): string | undefined {
  if (!hex || hex.toLowerCase() === '0x') return undefined;

  const stripped = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return undefined;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(stripped, 'hex');
  } catch {
    return undefined;
  }

  for (const byte of buffer) {
    // Strict ASCII printable (0x20-0x7E) or newline (0x0A)
    if (!(byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))) {
      return undefined;
    }
  }

  return buffer.toString('ascii');
}

/**
 * Resolve --payload vs --payload-ascii into a hex payload string.
 * Validates mutual exclusion and converts ASCII text if needed.
 */
export function resolvePayload(payload: string, payloadAscii?: string): string {
  if (payloadAscii !== undefined && payload !== '0x') {
    throw new CliError(
      'Cannot use both --payload and --payload-ascii. Use one or the other.',
      'CONFLICTING_PAYLOAD',
    );
  }
  if (payloadAscii !== undefined) {
    return textToHex(payloadAscii);
  }
  return payload;
}
