import { textToHex, tryHexToText, resolvePayload } from '../payload';
import { CliError } from '../errors';

describe('textToHex', () => {
  it('converts ASCII text to hex', () => {
    expect(textToHex('Hello')).toBe('0x48656c6c6f');
  });

  it('converts empty string to 0x', () => {
    expect(textToHex('')).toBe('0x');
  });

  it('converts text with newlines', () => {
    expect(textToHex('Hi\n')).toBe('0x48690a');
  });

  it('converts emoji (multi-byte UTF-8)', () => {
    const hex = textToHex('🦑');
    expect(hex).toBe('0xf09fa691');
  });

  it('converts text with spaces and punctuation', () => {
    expect(textToHex('Hello, World!')).toBe('0x48656c6c6f2c20576f726c6421');
  });
});

describe('tryHexToText', () => {
  it('decodes valid ASCII hex to text', () => {
    expect(tryHexToText('0x48656c6c6f')).toBe('Hello');
  });

  it('decodes hex with newlines', () => {
    expect(tryHexToText('0x48690a')).toBe('Hi\n');
  });

  it('returns undefined for empty "0x"', () => {
    expect(tryHexToText('0x')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(tryHexToText('')).toBeUndefined();
  });

  it('returns undefined for odd-length hex', () => {
    expect(tryHexToText('0x486')).toBeUndefined();
  });

  it('returns undefined for binary/non-printable bytes', () => {
    // NUL byte
    expect(tryHexToText('0x0048')).toBeUndefined();
    // Control char (0x01)
    expect(tryHexToText('0x0148')).toBeUndefined();
    // DEL (0x7F)
    expect(tryHexToText('0x7f48')).toBeUndefined();
  });

  it('returns undefined for high bytes (non-ASCII UTF-8)', () => {
    // emoji bytes (0xf0 > 0x7e)
    expect(tryHexToText('0xf09fa691')).toBeUndefined();
  });

  it('handles uppercase 0X prefix', () => {
    expect(tryHexToText('0X48656c6c6f')).toBe('Hello');
  });

  it('handles hex without prefix', () => {
    expect(tryHexToText('48656c6c6f')).toBe('Hello');
  });

  it('returns undefined for null/undefined input', () => {
    expect(tryHexToText(null as unknown as string)).toBeUndefined();
    expect(tryHexToText(undefined as unknown as string)).toBeUndefined();
  });
});

describe('resolvePayload', () => {
  it('passes through hex payload when no ASCII provided', () => {
    expect(resolvePayload('0xdeadbeef')).toBe('0xdeadbeef');
  });

  it('passes through default "0x" when no ASCII provided', () => {
    expect(resolvePayload('0x')).toBe('0x');
  });

  it('converts ASCII text when provided', () => {
    expect(resolvePayload('0x', 'Hello')).toBe('0x48656c6c6f');
  });

  it('throws when both payload and payload-ascii are provided', () => {
    expect(() => resolvePayload('0xdeadbeef', 'Hello')).toThrow(CliError);
    expect(() => resolvePayload('0xdeadbeef', 'Hello')).toThrow('Cannot use both --payload and --payload-ascii');
  });

  it('allows payload-ascii with default "0x" payload', () => {
    // Default payload is "0x" — this is not a conflict
    expect(resolvePayload('0x', 'test')).toBe('0x74657374');
  });
});
