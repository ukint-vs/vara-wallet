import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadArgsJson,
  __setStdinReaderForTests,
  __setStatSizeOverrideForTests,
} from '../utils/args-source';
import { CliError } from '../utils/errors';

describe('loadArgsJson', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'args-source-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('inline --args', () => {
    it('returns parsed array from inline JSON', () => {
      expect(loadArgsJson({ args: '[1,2,3]' })).toEqual([1, 2, 3]);
    });

    it('returns parsed object from inline JSON', () => {
      expect(loadArgsJson({ args: '{"a":1}' })).toEqual({ a: 1 });
    });

    it('throws INVALID_ARGS on malformed inline JSON', () => {
      try {
        loadArgsJson({ args: '[1,' });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('INVALID_ARGS');
      }
    });
  });

  describe('--args-file', () => {
    it('reads and parses JSON from a file', () => {
      const p = path.join(tmpDir, 'good.json');
      fs.writeFileSync(p, '[1,2,3]');
      expect(loadArgsJson({ argsFile: p })).toEqual([1, 2, 3]);
    });

    it('preserves nested structures byte-for-byte', () => {
      const p = path.join(tmpDir, 'nested.json');
      const value = { a: [1, { b: 'x', c: [true, null] }], d: '0xabcd' };
      fs.writeFileSync(p, JSON.stringify(value));
      expect(loadArgsJson({ argsFile: p })).toEqual(value);
    });

    it('throws ARGS_FILE_READ_ERROR for missing file', () => {
      try {
        loadArgsJson({ argsFile: path.join(tmpDir, 'missing.json') });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('ARGS_FILE_READ_ERROR');
      }
    });

    it('throws ARGS_FILE_TOO_LARGE when file > 10 MB', () => {
      // Mock file size via the test seam rather than writing 11 MB to disk.
      __setStatSizeOverrideForTests(() => 11_000_000);
      try {
        const p = path.join(tmpDir, 'big.json');
        fs.writeFileSync(p, '[]');
        expect(() => loadArgsJson({ argsFile: p })).toThrow(/too large/);
        try {
          loadArgsJson({ argsFile: p });
        } catch (err) {
          expect((err as CliError).code).toBe('ARGS_FILE_TOO_LARGE');
        }
      } finally {
        __setStatSizeOverrideForTests(null);
      }
    });

    describe('privacy: malformed JSON must NOT leak the file path', () => {
      it('omits the file path from the parse-error message', () => {
        const p = path.join(tmpDir, 'secret-seed.json');
        fs.writeFileSync(p, '[1, "missing-quote]');
        try {
          loadArgsJson({ argsFile: p });
          fail('expected throw');
        } catch (err) {
          expect(err).toBeInstanceOf(CliError);
          const cli = err as CliError;
          expect(cli.code).toBe('INVALID_ARGS');
          expect(cli.message).not.toContain(p);
          expect(cli.message).not.toContain('secret-seed');
          expect(cli.message).not.toContain(tmpDir);
          // Should still be useful: indicates a parse failure with position
          expect(cli.message.toLowerCase()).toContain('parse');
        }
      });
    });
  });

  describe('--args-file -  (stdin)', () => {
    let originalIsTTY: boolean | undefined;

    beforeEach(() => {
      originalIsTTY = process.stdin.isTTY;
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
      __setStdinReaderForTests(null);
    });

    it('reads from the stdin seam when piped', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      __setStdinReaderForTests(() => '[7,8,9]');
      expect(loadArgsJson({ argsFile: '-' })).toEqual([7, 8, 9]);
    });

    it('throws STDIN_IS_TTY when stdin is a terminal', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        loadArgsJson({ argsFile: '-' });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('STDIN_IS_TTY');
      }
    });

    it('throws INVALID_ARGS on empty stdin', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      __setStdinReaderForTests(() => '');
      try {
        loadArgsJson({ argsFile: '-' });
        fail('expected throw');
      } catch (err) {
        expect((err as CliError).code).toBe('INVALID_ARGS');
      }
    });

    it('throws ARGS_FILE_TOO_LARGE when stdin payload exceeds 10 MB', () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      // 10 MB + 1 byte. Use a string of valid-JSON-shaped digits to skip the
      // empty-input check; size cap should fire before JSON.parse runs.
      const oversized = '0'.repeat(10 * 1024 * 1024 + 1);
      __setStdinReaderForTests(() => oversized);
      try {
        loadArgsJson({ argsFile: '-' });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('ARGS_FILE_TOO_LARGE');
      }
    });
  });

  describe('mutual exclusion', () => {
    it('throws INVALID_ARGS_SOURCE when both --args and --args-file are set', () => {
      const p = path.join(tmpDir, 'mx.json');
      fs.writeFileSync(p, '[]');
      try {
        loadArgsJson({ args: '[]', argsFile: p });
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('INVALID_ARGS_SOURCE');
        expect((err as CliError).message).toContain('--args-file');
      }
    });
  });

  describe('default fallback', () => {
    it('returns parsed default when neither flag is set', () => {
      expect(loadArgsJson({ argsDefault: '[]' })).toEqual([]);
    });

    it('throws MISSING_ARGS_SOURCE when neither flag is set and no default', () => {
      try {
        loadArgsJson({});
        fail('expected throw');
      } catch (err) {
        expect((err as CliError).code).toBe('MISSING_ARGS_SOURCE');
      }
    });
  });
});
