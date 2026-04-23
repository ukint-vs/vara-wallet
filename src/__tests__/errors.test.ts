import { CliError, formatError, classifyProgramError } from '../utils/errors';

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

  it('serializes plain object non-Error values as JSON', () => {
    const obj = { method: 'InsufficientBalance', docs: 'Insufficient user balance.' };
    const result = formatError(obj);
    expect(result.code).toBe('UNKNOWN_ERROR');
    expect(result.error).toContain('InsufficientBalance');
    expect(result.error).toContain('Insufficient user balance.');
  });

  it('returns INTERNAL_ERROR for unclassified errors', () => {
    const err = new Error('something strange happened');
    expect(formatError(err).code).toBe('INTERNAL_ERROR');
  });

  it('merges CliError meta into the output object', () => {
    const err = new CliError('boom', 'PROGRAM_ERROR', {
      reason: 'panic',
      programMessage: 'zero error',
    });
    expect(formatError(err)).toEqual({
      error: 'boom',
      code: 'PROGRAM_ERROR',
      reason: 'panic',
      programMessage: 'zero error',
    });
  });

  it('omits meta fields when meta is absent (backward compatible shape)', () => {
    const err = new CliError('plain', 'SOME_CODE');
    const out = formatError(err);
    expect(out).toEqual({ error: 'plain', code: 'SOME_CODE' });
    expect(Object.keys(out).sort()).toEqual(['code', 'error']);
  });
});

describe('classifyProgramError', () => {
  it('classifies Rust-style panic with quoted message and extracts programMessage', () => {
    const err = new Error(
      "Program 0x1234 panicked with 'Result::unwrap() on Err value: zero error' at src/lib.rs:42",
    );
    const result = classifyProgramError(err);
    expect(result).toBeInstanceOf(CliError);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta).toEqual({
      reason: 'panic',
      programMessage: 'Result::unwrap() on Err value: zero error',
    });
  });

  it('classifies InactiveProgram errors', () => {
    const err = new Error('Program 0xabc returned InactiveProgram error');
    const result = classifyProgramError(err);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta?.reason).toBe('inactive');
  });

  it('classifies ProgramNotFound errors', () => {
    const err = new Error('ProgramNotFound: no such program');
    const result = classifyProgramError(err);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta?.reason).toBe('not_found');
  });

  it('classifies "does not exist" as not_found', () => {
    const err = new Error('Program 0xdead does not exist on-chain');
    const result = classifyProgramError(err);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta?.reason).toBe('not_found');
  });

  it('classifies "entered unreachable code" as unreachable', () => {
    const err = new Error('Program 0xfff entered unreachable code in src/svc.rs');
    const result = classifyProgramError(err);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta?.reason).toBe('unreachable');
  });

  it('falls back to PROGRAM_ERROR with no reason for unknown program errors', () => {
    const err = new Error('something went wrong inside the program');
    const result = classifyProgramError(err);
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.meta).toBeUndefined();
  });

  it('handles non-Error thrown values', () => {
    const result = classifyProgramError({ method: 'OutOfGas' });
    expect(result.code).toBe('PROGRAM_ERROR');
    expect(result.message).toContain('OutOfGas');
  });

  it('does NOT touch transport/timeout/connection classification', () => {
    // These continue to flow through formatError + classifyError, not classifyProgramError.
    expect(formatError(new Error('Request timeout')).code).toBe('TIMEOUT');
    expect(formatError(new Error('WebSocket connect failed')).code).toBe('CONNECTION_FAILED');
    expect(formatError(new Error('ENOENT: no such file')).code).toBe('NOT_FOUND');
  });

  it('formatError preserves reason and programMessage for a classified panic', () => {
    const err = new Error("panicked with 'zero error'");
    const cli = classifyProgramError(err);
    const formatted = formatError(cli);
    expect(formatted.code).toBe('PROGRAM_ERROR');
    expect(formatted.reason).toBe('panic');
    expect(formatted.programMessage).toBe('zero error');
  });
});
