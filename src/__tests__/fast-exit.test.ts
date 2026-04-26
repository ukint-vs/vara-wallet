import { fastExit } from '../utils/fast-exit';

/**
 * `fastExit` is the drain-then-exit helper that terminates the CLI without
 * truncating piped output. It's untested in integration because forcing
 * `writableNeedDrain=true` requires a real backed-up pipe; here we stub
 * the streams via Object.defineProperty (jest.spyOn 'get' fails because
 * `writableNeedDrain` is non-configurable on the live Writable proto).
 *
 * The bug it prevents: `process.exit()` does not flush async stdout/stderr
 * writes. Without the drain, `vara-wallet ... | jq` can lose the last
 * chunk on a slow consumer.
 */

type DrainHandler = () => void;
type StreamMock = {
  needDrain: boolean;
  onceCalls: Array<[string, DrainHandler]>;
};

function stubStream(stream: NodeJS.WriteStream): { restore: () => void; control: StreamMock } {
  const control: StreamMock = { needDrain: false, onceCalls: [] };
  const origDescriptor =
    Object.getOwnPropertyDescriptor(stream, 'writableNeedDrain') ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(stream), 'writableNeedDrain');
  const origOnce = stream.once.bind(stream);
  Object.defineProperty(stream, 'writableNeedDrain', {
    configurable: true,
    get: () => control.needDrain,
  });
  stream.once = ((event: string, handler: DrainHandler) => {
    control.onceCalls.push([event, handler]);
    return stream;
  }) as typeof stream.once;
  return {
    control,
    restore: () => {
      delete (stream as unknown as Record<string, unknown>).writableNeedDrain;
      if (origDescriptor) {
        Object.defineProperty(stream, 'writableNeedDrain', origDescriptor);
      }
      stream.once = origOnce;
    },
  };
}

describe('fastExit', () => {
  let exitSpy: jest.SpyInstance;
  let stdoutStub: { restore: () => void; control: StreamMock };
  let stderrStub: { restore: () => void; control: StreamMock };

  beforeEach(() => {
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((_code?: number) => undefined as never) as never);
    stdoutStub = stubStream(process.stdout);
    stderrStub = stubStream(process.stderr);
  });

  afterEach(() => {
    stdoutStub.restore();
    stderrStub.restore();
    exitSpy.mockRestore();
  });

  it('exits immediately when neither stream needs drain', () => {
    fastExit(0);

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stdoutStub.control.onceCalls).toHaveLength(0);
    expect(stderrStub.control.onceCalls).toHaveLength(0);
  });

  it('waits for stdout drain when stdout has unflushed bytes', () => {
    stdoutStub.control.needDrain = true;

    fastExit(0);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutStub.control.onceCalls).toEqual([['drain', expect.any(Function)]]);

    stdoutStub.control.onceCalls[0][1]();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('drains stderr first, then stdout, then exits', () => {
    stderrStub.control.needDrain = true;
    stdoutStub.control.needDrain = true;

    fastExit(2);

    // No exit yet — waiting on stderr drain. stdout handler not registered yet.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrStub.control.onceCalls).toEqual([['drain', expect.any(Function)]]);
    expect(stdoutStub.control.onceCalls).toHaveLength(0);

    // Fire stderr drain → handler registers stdout drain listener.
    stderrStub.control.onceCalls[0][1]();
    expect(stdoutStub.control.onceCalls).toEqual([['drain', expect.any(Function)]]);
    expect(exitSpy).not.toHaveBeenCalled();

    // Fire stdout drain → process exits.
    stdoutStub.control.onceCalls[0][1]();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('forwards the exit code', () => {
    fastExit(42);

    expect(exitSpy).toHaveBeenCalledWith(42);
  });
});
