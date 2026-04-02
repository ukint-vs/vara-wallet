import { CliError } from '../utils/errors';

// Test the withTimeout pattern used in api.ts
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CliError(message, 'CONNECTION_TIMEOUT')), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

describe('withTimeout', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await withTimeout(
      Promise.resolve('ok'),
      1000,
      'Should not fire',
    );
    expect(result).toBe('ok');
  });

  it('rejects with CONNECTION_TIMEOUT when promise is too slow', async () => {
    jest.useFakeTimers();
    const slow = new Promise<string>(() => {}); // never resolves
    const promise = withTimeout(slow, 50, 'Timed out');
    jest.advanceTimersByTime(60);
    await expect(promise).rejects.toThrow('Timed out');
    jest.useRealTimers();
  });

  it('has correct error code on timeout', async () => {
    jest.useFakeTimers();
    const slow = new Promise<string>(() => {});
    const promise = withTimeout(slow, 50, 'Timed out');
    jest.advanceTimersByTime(60);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('CONNECTION_TIMEOUT');
    }
    jest.useRealTimers();
  });

  it('clears timer on fast resolution (no leaked timers)', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    await withTimeout(Promise.resolve(42), 10000, 'msg');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('propagates original errors (not timeout) when promise rejects fast', async () => {
    const failing = Promise.reject(new Error('original'));
    await expect(
      withTimeout(failing, 10000, 'timeout msg'),
    ).rejects.toThrow('original');
  });

  it('clears timer on fast rejection (no leaked timers)', async () => {
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    const failing = Promise.reject(new Error('fast fail'));
    await withTimeout(failing, 10000, 'msg').catch(() => {});
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
