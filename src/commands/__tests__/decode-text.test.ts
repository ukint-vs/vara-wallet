import { tryHexToText } from '../../utils';

// Tests for the `decode text` codepath in encode.ts
// The actual command wiring is tested via integration; here we test the core logic.

describe('decode text (via tryHexToText)', () => {
  it('decodes valid ASCII hex', () => {
    expect(tryHexToText('0x48656c6c6f')).toBe('Hello');
  });

  it('decodes hex with spaces and punctuation', () => {
    expect(tryHexToText('0x48656c6c6f2c20576f726c6421')).toBe('Hello, World!');
  });

  it('returns undefined for binary payload', () => {
    // SCALE-encoded data with non-printable bytes
    expect(tryHexToText('0x00010203')).toBeUndefined();
  });

  it('returns undefined for empty hex', () => {
    expect(tryHexToText('0x')).toBeUndefined();
  });

  it('returns undefined for odd-length hex', () => {
    expect(tryHexToText('0x486')).toBeUndefined();
  });

  it('decodes multi-word text with newlines', () => {
    // "Hello\nWorld"
    expect(tryHexToText('0x48656c6c6f0a576f726c64')).toBe('Hello\nWorld');
  });
});
