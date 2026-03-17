import { CliError, formatError } from '../utils/errors';

describe('CliError', () => {
  it('stores message and code', () => {
    const err = new CliError('something broke', 'BROKEN');
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('BROKEN');
    expect(err.name).toBe('CliError');
  });
});

describe('formatError', () => {
  it('formats CliError', () => {
    const err = new CliError('bad input', 'INVALID_INPUT');
    expect(formatError(err)).toEqual({ error: 'bad input', code: 'INVALID_INPUT' });
  });

  it('classifies connection errors', () => {
    const err = new Error('WebSocket connection failed');
    const result = formatError(err);
    expect(result.code).toBe('CONNECTION_FAILED');
  });

  it('classifies timeout errors', () => {
    const err = new Error('Request timeout');
    expect(formatError(err).code).toBe('TIMEOUT');
  });

  it('classifies not-found errors', () => {
    const err = new Error('ENOENT: no such file');
    expect(formatError(err).code).toBe('NOT_FOUND');
  });

  it('sanitizes seed URIs from error messages', () => {
    const err = new Error('Failed with //Alice');
    const result = formatError(err);
    expect(result.error).not.toContain('//Alice');
    expect(result.error).toContain('//***');
  });

  it('sanitizes hex secrets from error messages', () => {
    const longHex = '0x' + 'a'.repeat(64);
    const err = new Error(`Key ${longHex} is invalid`);
    const result = formatError(err);
    expect(result.error).not.toContain(longHex);
    expect(result.error).toContain('0x***');
  });

  it('returns UNKNOWN_ERROR for non-Error values', () => {
    expect(formatError('oops')).toEqual({ error: 'oops', code: 'UNKNOWN_ERROR' });
  });

  it('returns INTERNAL_ERROR for unclassified errors', () => {
    const err = new Error('something strange happened');
    expect(formatError(err).code).toBe('INTERNAL_ERROR');
  });
});
