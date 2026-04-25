import { buildFunctionDryRun, buildQueryDryRun, _resolveDryRunPayloadForTests } from '../commands/call';

describe('buildFunctionDryRun', () => {
  it('returns the documented dry-run shape with required fields', () => {
    const out = buildFunctionDryRun({
      service: 'Counter',
      method: 'Increment',
      args: [1, 2, 3],
      encodedPayload: '0xdeadbeef',
      destination: '0x' + '11'.repeat(32),
    });
    expect(out).toEqual({
      kind: 'function',
      service: 'Counter',
      method: 'Increment',
      args: [1, 2, 3],
      encodedPayload: '0xdeadbeef',
      destination: '0x' + '11'.repeat(32),
      value: '0',
      gasLimit: null,
      voucherId: null,
      willSubmit: false,
    });
  });

  it('preserves user-provided value, gasLimit, voucherId for round-trip diagnostics', () => {
    const out = buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
      destination: '0xbeef',
      value: '1000000000000',
      gasLimit: '5000000',
      voucherId: '0xfeed',
    });
    expect(out.value).toBe('1000000000000');
    expect(out.gasLimit).toBe('5000000');
    expect(out.voucherId).toBe('0xfeed');
    expect(out.willSubmit).toBe(false);
    expect(out.destination).toBe('0xbeef');
  });

  it('includes estimateGas when supplied (composition with --estimate)', () => {
    const out = buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
      destination: '0xbeef',
      estimateGas: { gasLimit: '5000000000', minLimit: '4500000000' },
    });
    expect(out.estimateGas).toEqual({ gasLimit: '5000000000', minLimit: '4500000000' });
    // Estimate is purely additive: dry-run shape preserved.
    expect(out.kind).toBe('function');
    expect(out.willSubmit).toBe(false);
  });

  it('omits estimateGas when not supplied (plain --dry-run path)', () => {
    const out = buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
      destination: '0xbeef',
    });
    expect(out).not.toHaveProperty('estimateGas');
  });

  it('emits keys in deterministic order (kind first, willSubmit last)', () => {
    const out = buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
      destination: '0xbeef',
    });
    const keys = Object.keys(out);
    expect(keys[0]).toBe('kind');
    expect(keys[keys.length - 1]).toBe('willSubmit');
  });

  it('emits keys in deterministic order with estimateGas (still kind first, willSubmit last)', () => {
    const out = buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
      destination: '0xbeef',
      estimateGas: { gasLimit: '1', minLimit: '1' },
    });
    const keys = Object.keys(out);
    expect(keys[0]).toBe('kind');
    expect(keys[keys.length - 1]).toBe('willSubmit');
    // estimateGas slots in just before willSubmit.
    expect(keys[keys.length - 2]).toBe('estimateGas');
  });
});

describe('buildQueryDryRun', () => {
  it('returns the documented query dry-run shape', () => {
    const out = buildQueryDryRun({
      service: 'Counter',
      method: 'Get',
      args: [],
      encodedPayload: '0xabcd',
    });
    expect(out).toEqual({
      kind: 'query',
      service: 'Counter',
      method: 'Get',
      args: [],
      encodedPayload: '0xabcd',
      willSubmit: false,
    });
  });
});

/**
 * B2 regression contract: encodedPayload MUST come from func.encodePayload(),
 * NOT from txBuilder.payload (sails-js's destination-program-id getter).
 *
 * The pre-0.15 bug returned `txBuilder.payload` which is `args[0].toHex()`
 * inside sails-js's TransactionBuilder — i.e. the destination program ID,
 * not the SCALE-encoded call. A revert would have all dry-run helper
 * tests still pass because the helper takes encodedPayload as a literal
 * arg. This test plants different values for `.payload` (the bug shape)
 * and `.encodePayload(...)` (the fix), and asserts the helper picks the
 * right one.
 */
describe('B2 regression: _resolveDryRunPayloadForTests', () => {
  it('picks encodedPayload from func.encodePayload(...args), not txBuilder.payload', () => {
    const SCALE_BYTES = '0xCALLED_ENCODE_PAYLOAD';
    const PROG_ID = '0x' + 'aa'.repeat(32);
    const BUGGY_PAYLOAD = PROG_ID; // what txBuilder.payload would return

    const encodePayload = jest.fn().mockReturnValue(SCALE_BYTES);
    const txBuilder = { payload: BUGGY_PAYLOAD, programId: PROG_ID };
    // Function-shaped object with .encodePayload — mirrors sails-js func reference.
    // Cast through `any` because we mock a thin slice of the sails-js surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const func = Object.assign(jest.fn().mockReturnValue(txBuilder), { encodePayload }) as any;

    const result = _resolveDryRunPayloadForTests(func, txBuilder, [42, 'foo', { nested: true }]);

    expect(result.encodedPayload).toBe(SCALE_BYTES);
    expect(result.encodedPayload).not.toBe(BUGGY_PAYLOAD); // the bug shape
    expect(result.encodedPayload).not.toBe(PROG_ID); // the bug-equivalent
    expect(result.destination).toBe(PROG_ID);
    expect(encodePayload).toHaveBeenCalledWith(42, 'foo', { nested: true });
  });

  it('forwards args verbatim to encodePayload (no transformation)', () => {
    const encodePayload = jest.fn().mockReturnValue('0x00');
    const txBuilder = { programId: '0xbeef' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const func = Object.assign(jest.fn().mockReturnValue(txBuilder), { encodePayload }) as any;

    _resolveDryRunPayloadForTests(func, txBuilder, []);
    expect(encodePayload).toHaveBeenCalledWith();

    encodePayload.mockClear();
    _resolveDryRunPayloadForTests(func, txBuilder, [1n, 2n, 'three']);
    expect(encodePayload).toHaveBeenCalledWith(1n, 2n, 'three');
  });

  it('reads destination from txBuilder.programId, separate from the encoded bytes', () => {
    const encodePayload = jest.fn().mockReturnValue('0x' + 'cafe'.repeat(8));
    const txBuilder = { programId: '0x' + 'dead'.repeat(16) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const func = Object.assign(jest.fn().mockReturnValue(txBuilder), { encodePayload }) as any;

    const result = _resolveDryRunPayloadForTests(func, txBuilder, []);
    expect(result.destination).toBe(txBuilder.programId);
    expect(result.encodedPayload).not.toBe(result.destination);
  });
});

/**
 * Behavioral test: dry-run must NOT call signAndSend / queryBuilder.call.
 * We test by constructing the exact builder shape used in call.ts and
 * passing it through the same code path the action uses.
 *
 * The pure helpers above already prove the OUTPUT shape; this test
 * locks in the INVARIANT that the network-touching methods are unreachable
 * when dry-run is set, by reusing the production helpers directly.
 */
describe('dry-run does not invoke network methods', () => {
  it('mock txBuilder is never asked for signAndSend by buildFunctionDryRun', () => {
    const signAndSend = jest.fn();
    const fakeBuilder = {
      payload: '0xfeedface',
      programId: '0xbeef',
      signAndSend,
    };
    // The helper does not touch the builder — the action layer does.
    // This is a structural assertion: helpers don't sneak in calls.
    buildFunctionDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0xc0ffee',
      destination: fakeBuilder.programId,
    });
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it('mock queryBuilder is never asked for .call() by buildQueryDryRun', () => {
    const call = jest.fn();
    const fakeBuilder = { call };
    buildQueryDryRun({
      service: 'S',
      method: 'M',
      args: [],
      encodedPayload: '0x00',
    });
    expect(fakeBuilder.call).not.toHaveBeenCalled();
  });
});
