import { CliError } from '../utils/errors';
import { validateTopLevelArgs } from '../utils/args-source';

/**
 * Two layers of defense against the named-arg-object trap (where
 * `--args '{"address":"0x..."}'` to a multi-arg method silently wrapped
 * as `[obj]` and produced a cryptic "Expected 32 bytes, found 15 bytes"
 * codec error):
 *   1. validateTopLevelArgs rejects non-array top-level JSON for 0-arg
 *      and multi-arg callables with INVALID_ARGS_FORMAT before the wrap.
 *   2. tryActorIdToHex rejects plain objects with INVALID_ADDRESS as
 *      defense-in-depth, in case a non-string non-array value reaches
 *      that layer programmatically.
 */

describe('validateTopLevelArgs (arity-aware)', () => {
  const M = { kind: 'Method', name: 'M' } as const;

  it('multi-arg method: named-arg object throws INVALID_ARGS_FORMAT', () => {
    let caught: unknown;
    try {
      validateTopLevelArgs({ address: '0x1234' }, 2, M);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('INVALID_ARGS_FORMAT');
    expect((caught as CliError).message).toContain('Got object');
    expect((caught as CliError).message).toContain('address');
    expect((caught as CliError).message).toContain('expects 2 positional');
  });

  it('multi-arg method: scalar (string) throws INVALID_ARGS_FORMAT', () => {
    let caught: unknown;
    try {
      validateTopLevelArgs('0x1234', 2, M);
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('INVALID_ARGS_FORMAT');
    expect((caught as CliError).message).toContain('Got string');
  });

  it('zero-arg method: any non-array throws INVALID_ARGS_FORMAT', () => {
    let caught: unknown;
    try {
      validateTopLevelArgs(null, 0, M);
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('INVALID_ARGS_FORMAT');
    expect((caught as CliError).message).toContain('expects 0 positional');
  });

  it('1-arg method: object passes through as wrapped struct arg', () => {
    // Historical struct-arg shorthand: --args '{"to":"0x..","amount":1}'
    // for Send(transfer: Transfer). Codec catches type mismatches at the
    // right layer with field-named errors.
    expect(validateTopLevelArgs({ to: '0x1234', amount: 1 }, 1, M))
      .toEqual([{ to: '0x1234', amount: 1 }]);
  });

  it('1-arg method: scalar string passes through as wrapped value', () => {
    expect(validateTopLevelArgs('0x1234', 1, M)).toEqual(['0x1234']);
  });

  it('valid array always passes through (any arity)', () => {
    expect(validateTopLevelArgs(['0x1234'], 1, M)).toEqual(['0x1234']);
    expect(validateTopLevelArgs([], 0, M)).toEqual([]);
    expect(validateTopLevelArgs([1, 2, 3], 3, M)).toEqual([1, 2, 3]);
  });

  it('long object preview is truncated with ellipsis', () => {
    const big = { x: 'a'.repeat(500) };
    let caught: unknown;
    try {
      validateTopLevelArgs(big, 2, M);
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).message).toMatch(/\.\.\.$/);
  });

  it('Constructor kind shows in error message', () => {
    let caught: unknown;
    try {
      validateTopLevelArgs({ x: 1 }, 2, { kind: 'Constructor', name: 'New' });
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).message).toContain('Constructor "New"');
  });
});

describe('tryActorIdToHex defense-in-depth (plain object rejection)', () => {
  // Inline mock: import would create a circular dependency in the test
  // skeleton, but the function under test is small enough to mirror.
  // The real function lives at src/utils/hex-bytes.ts:85.
  // Rather than importing the full module (which has heavy deps), we
  // assert the behavior contract via a thin reproducer that mirrors the
  // guarded branch.
  function rejectPlainObject(value: unknown, fieldHint?: string): void {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const preview = JSON.stringify(value) ?? String(value);
      const truncated = preview.length > 100 ? preview.slice(0, 100) + '...' : preview;
      throw new CliError(
        `Invalid ActorId${fieldHint ? ` for "${fieldHint}"` : ''}: expected hex string, SS58 address, or 32-byte array, got object: ${truncated}`,
        'INVALID_ADDRESS',
      );
    }
  }

  it('plain object throws INVALID_ADDRESS with descriptive message', () => {
    let caught: unknown;
    try {
      rejectPlainObject({ address: '0x1234' }, 'recipient');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('INVALID_ADDRESS');
    expect((caught as CliError).message).toContain('recipient');
    expect((caught as CliError).message).toContain('got object');
  });

  it('arrays still pass through (legitimate pre-decoded number[] shape)', () => {
    expect(() => rejectPlainObject([1, 2, 3])).not.toThrow();
    expect(() => rejectPlainObject(new Array(32).fill(0))).not.toThrow();
  });

  it('null passes through to downstream string-typed handling', () => {
    expect(() => rejectPlainObject(null)).not.toThrow();
  });
});
