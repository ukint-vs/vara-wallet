import { CliError, classifyProgramError, formatError } from '../utils/errors';

/**
 * Pins the contract that calculateGas reverts surface as PROGRAM_ERROR
 * with a structured `reason` subcode. Without classification, agents see
 * "gas calculation failed" and chase phantom multiplier flags instead of
 * fixing the real state issue (e.g. approving an exhausted allowance).
 */
describe('calculateGas error classification', () => {
  function makeFailingTxBuilder(message: string) {
    return {
      withAccount: jest.fn(),
      withValue: jest.fn(),
      withGas: jest.fn(),
      withVoucher: jest.fn(),
      calculateGas: jest.fn().mockRejectedValue(new Error(message)),
    };
  }

  async function calcAndClassify(tb: { calculateGas: () => Promise<unknown> }): Promise<unknown> {
    try {
      return await tb.calculateGas();
    } catch (err) {
      throw classifyProgramError(err);
    }
  }

  // Sails `#[export(unwrap_result)]` wraps typed Result<T, E> errors in the
  // default Rust `.unwrap()` panic prefix; without stripping, programMessage
  // is the whole wrapper and agents can't switch on the bare variant.
  it('contract panic (Sails unwrap_result wrapper) → programMessage = bare variant', async () => {
    const tb = makeFailingTxBuilder(
      "Program 0xabcd panicked with 'called `Result::unwrap()` on an `Err` value: BetTokenTransferFromFailed' at app/src/lib.rs:424",
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cli = caught as CliError;
    expect(cli.code).toBe('PROGRAM_ERROR');
    expect(cli.meta).toEqual({
      reason: 'panic',
      programMessage: 'BetTokenTransferFromFailed',
    });

    // The agent-visible JSON shape an oncall agent would parse.
    const formatted = formatError(cli);
    expect(formatted.code).toBe('PROGRAM_ERROR');
    expect(formatted.reason).toBe('panic');
    expect(formatted.programMessage).toBe('BetTokenTransferFromFailed');
    expect(formatted.code).not.toBe('INTERNAL_ERROR');
  });

  // Two production quirks: (1) `Result::unwrap, ` with comma+space instead
  // of `()` — gear/sails version dependent; (2) double trailing apostrophe
  // from layered `Panic occurred: '...'` + `panicked with '...'` quoting.
  it('mainnet wrapper shape (Result::unwrap, with double trailing quote) strips cleanly', async () => {
    const tb = makeFailingTxBuilder(
      `8000: Runtime error: "Program terminated with a trap: 'Panic occurred: panicked with 'called \`Result::unwrap, \` on an \`Err\` value: NoItems''"`,
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('panic');
    expect((caught as CliError).meta?.programMessage).toBe('NoItems');
  });

  it('variant with payload preserves payload in programMessage', async () => {
    const tb = makeFailingTxBuilder(
      "Program 0xabcd panicked with 'called `Result::unwrap()` on an `Err` value: InsufficientBalance(100)' at lib.rs:1",
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).meta?.programMessage).toBe('InsufficientBalance(100)');
  });

  it('custom panic message without Result::unwrap wrapper passes through', async () => {
    const tb = makeFailingTxBuilder(
      "Program 0xabcd panicked with 'oracle feed stale' at lib.rs:1",
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).meta?.programMessage).toBe('oracle feed stale');
  });

  it('inactive program during calculateGas surfaces as PROGRAM_ERROR with reason: inactive', async () => {
    const tb = makeFailingTxBuilder('Program returned InactiveProgram');

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('inactive');
  });

  // gear node returns RPC code 8000 with `Program not found` when
  // calculateGas.handle targets a non-program destination. The classifier
  // must recognize this so message.ts can apply the gas=0 fallback only
  // for that legit case, not swallow real panics.
  it('gear-node "Program not found" RPC error surfaces as reason: not_found', async () => {
    const tb = makeFailingTxBuilder(
      "8000: Runtime error: Program not found",
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('not_found');
  });

  // On gear-node spec 11000+, calculateGas.handle to a non-program
  // destination returns "entered unreachable code: Failed to get last
  // message from the queue" instead of "Program not found". message.ts
  // must recognize this AND fall back to gas=0 so user-account sends
  // keep working with auto-gas.
  it('"unreachable code: Failed to get last message from the queue" classifies as reason: unreachable', async () => {
    const tb = makeFailingTxBuilder(
      `8000: Runtime error: "Internal error: entered unreachable code 'Failed to get last message from the queue'"`,
    );

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('unreachable');
    // The substring `Failed to get last message from the queue` must be
    // preserved in the formatted error so message.ts:98 can recognize it
    // and apply the gas=0 fallback for user-account destinations.
    expect((caught as CliError).message).toMatch(/Failed to get last message from the queue/);
  });

  it('"ProgramNotFound" pallet variant also classifies as not_found', async () => {
    const tb = makeFailingTxBuilder('Module error: ProgramNotFound');

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('PROGRAM_ERROR');
    expect((caught as CliError).meta?.reason).toBe('not_found');
  });

  // Negative case: generic "not found" without "Program" must NOT get the
  // PROGRAM_ERROR / reason: not_found classification. classifyProgramError
  // falls through to classifyError which returns NOT_FOUND (transport-level)
  // for those. This guards message.ts's gas=0 fallback: it triggers ONLY
  // for `meta.reason === 'not_found'` (program-level), so a generic
  // NOT_FOUND error rethrows instead of silently using gas=0.
  it('generic "Account not found" classifies as NOT_FOUND, not PROGRAM_ERROR', async () => {
    const tb = makeFailingTxBuilder('Account not found in storage');

    let caught: unknown;
    try {
      await calcAndClassify(tb);
    } catch (err) {
      caught = err;
    }

    expect((caught as CliError).code).toBe('NOT_FOUND');
    // No `meta.reason` because this is the transport-classified branch,
    // not the PROGRAM_ERROR branch. message.ts's `cli.meta?.reason ===
    // 'not_found'` guard correctly rejects this.
    expect((caught as CliError).meta?.reason).toBeUndefined();
  });

  it('successful calculateGas does not invoke classification', async () => {
    const tb = {
      calculateGas: jest.fn().mockResolvedValue(undefined),
    };
    await expect(calcAndClassify(tb)).resolves.toBeUndefined();
  });
});
