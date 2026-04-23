import { CliError, classifyProgramError, formatError } from '../utils/errors';

/**
 * Regression coverage for issue #35: the query path in `vara-wallet call`
 * must classify program-execution failures (e.g. WASM panics) as
 * `PROGRAM_ERROR` with a structured `reason` subcode, not as the generic
 * `INTERNAL_ERROR` which (per the bug report) tells agents the CLI itself
 * broke and they should retry.
 *
 * We don't spin up the full Commander CLI here — `executeQuery` calls
 * `await queryBuilder.call()` and rethrows via `classifyProgramError`.
 * That contract is what consumers depend on, so we exercise it directly
 * with a mocked queryBuilder that throws the exact panic message
 * agents see today.
 */
describe('call command — query path program error classification (issue #35)', () => {
  // Minimal fake queryBuilder mirroring the surface used in executeQuery:
  // .withAddress() and .call() — call() rejects with a Sails-style panic.
  function makeFailingQueryBuilder(message: string) {
    return {
      withAddress: jest.fn(),
      call: jest.fn().mockRejectedValue(new Error(message)),
    };
  }

  // This mirrors executeQuery's try/catch around `await queryBuilder.call()`.
  async function callAndClassify(qb: { call: () => Promise<unknown> }): Promise<unknown> {
    try {
      return await qb.call();
    } catch (err) {
      throw classifyProgramError(err);
    }
  }

  it('panic from queryBuilder.call() becomes PROGRAM_ERROR with reason: panic', async () => {
    const qb = makeFailingQueryBuilder(
      "Program 0x1234 panicked with 'Result::unwrap() on Err value: zero error' at src/lib.rs:42",
    );

    let caught: unknown;
    try {
      await callAndClassify(qb);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cli = caught as CliError;
    expect(cli.code).toBe('PROGRAM_ERROR');
    expect(cli.meta).toEqual({
      reason: 'panic',
      programMessage: 'Result::unwrap() on Err value: zero error',
    });

    // And the JSON-formatted output an agent would see:
    const formatted = formatError(cli);
    expect(formatted.code).toBe('PROGRAM_ERROR');
    expect(formatted.reason).toBe('panic');
    expect(formatted.programMessage).toBe('Result::unwrap() on Err value: zero error');
    // Critically: NOT INTERNAL_ERROR.
    expect(formatted.code).not.toBe('INTERNAL_ERROR');
  });

  it('inactive program from queryBuilder.call() becomes PROGRAM_ERROR with reason: inactive', async () => {
    const qb = makeFailingQueryBuilder('Program returned InactiveProgram');
    let caught: unknown;
    try {
      await callAndClassify(qb);
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('inactive');
  });

  it('queryBuilder.call() resolving normally does not invoke classification', async () => {
    const qb = {
      withAddress: jest.fn(),
      call: jest.fn().mockResolvedValue({ ok: true }),
    };
    await expect(callAndClassify(qb)).resolves.toEqual({ ok: true });
  });
});
