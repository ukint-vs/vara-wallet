import { detectIdlVersion } from '../services/sails';

describe('detectIdlVersion', () => {
  it('returns "v2" for IDL with !@sails: directive on the first line', () => {
    expect(detectIdlVersion('!@sails: 1.0.0-beta.1\nservice Foo@0x00 {}')).toBe('v2');
  });

  it('returns "v2" when the directive has leading whitespace', () => {
    expect(detectIdlVersion('   !@sails: 1.0.0-beta.1\nservice Foo@0x00 {}')).toBe('v2');
  });

  it('returns "v2" when preceded by blank lines', () => {
    expect(detectIdlVersion('\n\n!@sails: 1.0.0-beta.1\n')).toBe('v2');
  });

  it('returns "v2" with CRLF line endings', () => {
    expect(detectIdlVersion('\r\n!@sails: 1.0.0-beta.1\r\nservice Foo@0x00 {}')).toBe('v2');
  });

  it('returns "v2" when the directive appears mid-file (permissive match)', () => {
    // Any line starting with !@sails: triggers v2 detection.
    expect(detectIdlVersion('// comment\n!@sails: 1.0.0-beta.2\nservice Foo@0x00 {}')).toBe('v2');
  });

  it('returns "unknown" for a classic v1 IDL with no directive', () => {
    expect(detectIdlVersion('service Foo { query Bar : () -> u32; };')).toBe('unknown');
  });

  it('returns "unknown" for an empty string', () => {
    expect(detectIdlVersion('')).toBe('unknown');
  });

  it('returns "unknown" when the directive is inside a comment', () => {
    // We match literally at the start of a line; comments don't start a line.
    expect(detectIdlVersion('// !@sails: 1.0.0-beta.1\nservice Foo {};')).toBe('unknown');
  });

  it('returns "unknown" for whitespace-only input', () => {
    expect(detectIdlVersion('   \n\n  \t\n')).toBe('unknown');
  });
});
