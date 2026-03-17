import { setOutputOptions, output, verbose } from '../utils/output';

describe('output', () => {
  let stdoutWrite: jest.SpyInstance;
  let stderrWrite: jest.SpyInstance;

  beforeEach(() => {
    stdoutWrite = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrWrite = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    setOutputOptions({});
  });

  it('outputs JSON when --json flag is set', () => {
    setOutputOptions({ json: true });
    output({ foo: 'bar' });
    expect(stdoutWrite).toHaveBeenCalledWith('{"foo":"bar"}\n');
  });

  it('suppresses output when --quiet flag is set', () => {
    setOutputOptions({ quiet: true });
    output({ foo: 'bar' });
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('serializes BigInt values in JSON', () => {
    setOutputOptions({ json: true });
    output({ value: BigInt('1000000000000') });
    expect(stdoutWrite).toHaveBeenCalledWith('{"value":"1000000000000"}\n');
  });
});

describe('verbose', () => {
  let stderrWrite: jest.SpyInstance;

  beforeEach(() => {
    stderrWrite = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrWrite.mockRestore();
    setOutputOptions({});
  });

  it('outputs to stderr when verbose is enabled', () => {
    setOutputOptions({ verbose: true });
    verbose('debug message');
    expect(stderrWrite).toHaveBeenCalled();
    const written = stderrWrite.mock.calls[0][0];
    expect(written).toContain('debug message');
  });

  it('suppresses output when verbose is not set', () => {
    setOutputOptions({});
    verbose('debug message');
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('suppresses output when quiet is set even if verbose', () => {
    setOutputOptions({ verbose: true, quiet: true });
    verbose('debug message');
    expect(stderrWrite).not.toHaveBeenCalled();
  });
});
