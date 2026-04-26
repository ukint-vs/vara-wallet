import { CliError, classifyProgramError, formatError } from '../utils/errors';

/**
 * Regression coverage for the gas-estimate failure path (Nexus session report,
 * 2026-04-25): when `calculateGas()` runs the message in a runtime sandbox and
 * the program reverts (e.g. cross-program transfer fails because allowance is
 * exhausted, or the contract panics), the underlying program error must
 * surface as `PROGRAM_ERROR` with a structured `reason` subcode — NOT as a
 * generic gas error string.
 *
 * Without classification, agents read "gas calculation failed" and chase
 * phantom multiplier flags instead of fixing the real state issue (e.g.
 * approving the spender). The fix is a try/catch around every
 * `await txBuilder.calculateGas()` / `api.program.calculateGas.*()` call site
 * in `src/commands/{call,program,message,dex,vft}.ts`, rethrowing via
 * `classifyProgramError`.
 *
 * This test pins that contract by mocking the txBuilder and asserting the
 * thrown CliError. We don't spin up the chain — the integration cost would
 * dwarf the value of this guarantee.
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

  // Mirrors the wrap pattern applied in commands/call.ts:312-318 etc.
  async function calcAndClassify(tb: { calculateGas: () => Promise<unknown> }): Promise<unknown> {
    try {
      return await tb.calculateGas();
    } catch (err) {
      throw classifyProgramError(err);
    }
  }

  it('contract panic during calculateGas surfaces as PROGRAM_ERROR with reason: panic', async () => {
    const tb = makeFailingTxBuilder(
      "Program 0xabcd panicked with 'BetTokenTransferFromFailed' at app/src/lib.rs:424",
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

  // Pinned: when `vara-wallet send-message <user-account-address>` runs and
  // calculateGas.handle is called against a non-program destination, the
  // gear node returns RPC code 8000 with data 'Program not found'.
  // polkadot's RpcError formats that into err.message as
  // "8000: <msg>: Program not found". The classifier MUST recognize this
  // form (lowercase 'n', with space) so that message.ts can use the
  // gas=0 fallback only for that legit case — not swallow real panics.
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

  // Pinned: on current Vara mainnet (spec 11000+), calculateGas.handle to a
  // non-program destination returns "entered unreachable code: Failed to get
  // last message from the queue", NOT "Program not found". message.ts must
  // recognize this AND classify it as the missing-program case so that
  // `vara-wallet message send <user-account>` keeps working with auto-gas.
  // Found by smoke testing against rpc.vara.network during the agent UX
  // hardening PR; older wording-only narrow catch broke this path.
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
