import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseIdlFileV2 } from '../services/sails';
import { coerceArgsAuto, loadArgsJson } from '../utils';
import { __setStdinReaderForTests } from '../utils/args-source';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-v2.idl');

/**
 * Round-trip parity test for issue #20: a 64-byte vec u8 + 32-byte fixed
 * array (the `SignedBetQuote` signature shape from the 2026-04-23 live
 * test) must encode byte-identically whether passed inline via --args or
 * loaded from a file via --args-file.
 *
 * Demo/Echo(data: [u8], hash: [u8; 32]) -> [u8] is the closest fixture
 * to the SignedBetQuote scenario (vec u8 + fixed-size byte array).
 */
describe('--args-file byte-identical round-trip', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'args-file-encode-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inline --args and --args-file produce byte-identical encodePayload output for 64-byte vec u8', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);

    // 64-byte hex (the SignedBetQuote signature length) + 32-byte hash.
    const data64 = '0x' + 'ab'.repeat(64);
    const hash32 = '0x' + 'cd'.repeat(32);
    const argsArray = [data64, hash32];

    // Path 1: inline (simulates --args)
    const inlineParsed = loadArgsJson({ args: JSON.stringify(argsArray) });

    // Path 2: file (simulates --args-file)
    const filePath = path.join(tmpDir, 'echo-args.json');
    fs.writeFileSync(filePath, JSON.stringify(argsArray));
    const fileParsed = loadArgsJson({ argsFile: filePath });

    expect(fileParsed).toEqual(inlineParsed);

    const echo = program.services['Demo'].functions['Echo'];

    const inlineCoerced = coerceArgsAuto(
      inlineParsed as unknown[],
      echo.args,
      program,
      'Demo',
    );
    const fileCoerced = coerceArgsAuto(
      fileParsed as unknown[],
      echo.args,
      program,
      'Demo',
    );

    const inlineEncoded = echo.encodePayload(...inlineCoerced);
    const fileEncoded = echo.encodePayload(...fileCoerced);

    expect(fileEncoded).toBe(inlineEncoded);
  });

  it('stdin path also produces byte-identical output (mocked)', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    const data64 = '0x' + '11'.repeat(64);
    const hash32 = '0x' + '22'.repeat(32);
    const argsArray = [data64, hash32];

    const inlineParsed = loadArgsJson({ args: JSON.stringify(argsArray) });

    // Mock stdin via the test seam.
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    __setStdinReaderForTests(() => JSON.stringify(argsArray));

    try {
      const stdinParsed = loadArgsJson({ argsFile: '-' });
      expect(stdinParsed).toEqual(inlineParsed);

      const echo = program.services['Demo'].functions['Echo'];
      const inlineCoerced = coerceArgsAuto(inlineParsed as unknown[], echo.args, program, 'Demo');
      const stdinCoerced = coerceArgsAuto(stdinParsed as unknown[], echo.args, program, 'Demo');
      expect(echo.encodePayload(...stdinCoerced)).toBe(echo.encodePayload(...inlineCoerced));
    } finally {
      __setStdinReaderForTests(null);
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});
