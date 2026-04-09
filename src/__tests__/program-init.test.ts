import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SailsIdlParser } from 'sails-js-parser';
import { Sails } from 'sails-js';
import { VFT_EXTENDED_IDL } from '../idl/bundled-idls';
import { resolveInitPayload } from '../commands/program';

// Minimal IDL with no constructor
const IDL_NO_CTOR = `service Foo {
  query Bar : () -> u32;
};`;

// IDL with two constructors (for multi-ctor test)
const IDL_MULTI_CTOR = `constructor {
  New : ();
  FromConfig : (value: u32);
};

service Foo {
  query Bar : () -> u32;
};`;

describe('program init encoding', () => {
  let parser: SailsIdlParser;
  let tmpDir: string;

  beforeAll(async () => {
    parser = await SailsIdlParser.new();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vara-wallet-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeIdl(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  function parseSails(idlString: string): Sails {
    const sails = new Sails(parser);
    sails.parseIdl(idlString);
    return sails;
  }

  describe('constructor discovery', () => {
    it('finds single constructor from VFT IDL', () => {
      const sails = parseSails(VFT_EXTENDED_IDL);
      const ctors = sails.ctors;
      expect(ctors).not.toBeNull();
      const names = Object.keys(ctors!);
      expect(names).toEqual(['New']);
    });

    it('finds multiple constructors', () => {
      const sails = parseSails(IDL_MULTI_CTOR);
      const ctors = sails.ctors;
      expect(ctors).not.toBeNull();
      const names = Object.keys(ctors!);
      expect(names).toEqual(['New', 'FromConfig']);
    });

    it('returns null ctors when IDL has no constructor', () => {
      const sails = parseSails(IDL_NO_CTOR);
      expect(sails.ctors).toBeNull();
    });
  });

  describe('constructor encoding', () => {
    it('encodes zero-arg constructor', () => {
      const sails = parseSails(IDL_MULTI_CTOR);
      const ctor = sails.ctors!['New'];
      const payload = ctor.encodePayload();
      // Should be SCALE-encoded string "New"
      expect(payload).toMatch(/^0x/);
      expect(payload.length).toBeGreaterThan(2);
    });

    it('encodes VFT constructor with args', () => {
      const sails = parseSails(VFT_EXTENDED_IDL);
      const ctor = sails.ctors!['New'];
      const payload = ctor.encodePayload('TestToken', 'TT', 18);
      expect(payload).toMatch(/^0x/);
      // The payload should contain the encoded constructor name + args
      expect(payload.length).toBeGreaterThan(10);
    });

    it('produces consistent output for same args', () => {
      const sails = parseSails(VFT_EXTENDED_IDL);
      const ctor = sails.ctors!['New'];
      const p1 = ctor.encodePayload('A', 'B', 8);
      const p2 = ctor.encodePayload('A', 'B', 8);
      expect(p1).toBe(p2);
    });

    it('produces different output for different args', () => {
      const sails = parseSails(VFT_EXTENDED_IDL);
      const ctor = sails.ctors!['New'];
      const p1 = ctor.encodePayload('TokenA', 'TA', 18);
      const p2 = ctor.encodePayload('TokenB', 'TB', 6);
      expect(p1).not.toBe(p2);
    });
  });

  describe('parseIdlFile', () => {
    // We test the sails.ts parseIdlFile function indirectly through its behavior.
    // Import it here since it's an async function that needs the WASM parser.
    let parseIdlFile: (idlPath: string) => Promise<Sails>;

    beforeAll(async () => {
      const mod = await import('../services/sails');
      parseIdlFile = mod.parseIdlFile;
    });

    it('parses a valid IDL file', async () => {
      const filePath = writeIdl('valid.idl', VFT_EXTENDED_IDL);
      const sails = await parseIdlFile(filePath);
      expect(sails.ctors).not.toBeNull();
      expect(Object.keys(sails.ctors!)).toEqual(['New']);
    });

    it('throws IDL_FILE_NOT_FOUND for missing file', async () => {
      await expect(parseIdlFile('/nonexistent/path/demo.idl')).rejects.toMatchObject({
        code: 'IDL_FILE_NOT_FOUND',
      });
    });

    it('throws IDL_PARSE_ERROR for malformed IDL', async () => {
      const filePath = writeIdl('bad.idl', 'this is not valid IDL content!!!');
      await expect(parseIdlFile(filePath)).rejects.toMatchObject({
        code: 'IDL_PARSE_ERROR',
      });
    });
  });

  describe('resolveInitPayload', () => {
    it('returns raw payload when no --idl', async () => {
      const result = await resolveInitPayload({ payload: '0xdeadbeef' });
      expect(result).toBe('0xdeadbeef');
    });

    it('returns default payload when no options', async () => {
      const result = await resolveInitPayload({ payload: '0x' });
      expect(result).toBe('0x');
    });

    it('throws MISSING_IDL when --init without --idl', async () => {
      await expect(resolveInitPayload({ payload: '0x', init: 'New' })).rejects.toMatchObject({
        code: 'MISSING_IDL',
      });
    });

    it('throws MISSING_IDL when --args without --idl', async () => {
      await expect(resolveInitPayload({ payload: '0x', args: '[]' })).rejects.toMatchObject({
        code: 'MISSING_IDL',
      });
    });

    it('throws MUTUALLY_EXCLUSIVE_OPTIONS when --payload and --idl both set', async () => {
      const idlPath = writeIdl('excl.idl', VFT_EXTENDED_IDL);
      await expect(resolveInitPayload({ payload: '0x1234', idl: idlPath })).rejects.toMatchObject({
        code: 'MUTUALLY_EXCLUSIVE_OPTIONS',
      });
    });

    it('throws NO_CONSTRUCTORS for IDL without constructor', async () => {
      const idlPath = writeIdl('noctor.idl', IDL_NO_CTOR);
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath })).rejects.toMatchObject({
        code: 'NO_CONSTRUCTORS',
      });
    });

    it('throws MULTIPLE_CONSTRUCTORS when IDL has multiple and --init not set', async () => {
      const idlPath = writeIdl('multi.idl', IDL_MULTI_CTOR);
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath })).rejects.toMatchObject({
        code: 'MULTIPLE_CONSTRUCTORS',
      });
    });

    it('throws CONSTRUCTOR_NOT_FOUND for wrong --init name', async () => {
      const idlPath = writeIdl('wrongname.idl', VFT_EXTENDED_IDL);
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath, init: 'DoesNotExist' })).rejects.toMatchObject({
        code: 'CONSTRUCTOR_NOT_FOUND',
      });
    });

    it('throws INVALID_ARGS for malformed JSON', async () => {
      const idlPath = writeIdl('badargs.idl', VFT_EXTENDED_IDL);
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath, args: 'not json' })).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      });
    });

    it('auto-selects single constructor', async () => {
      const idlPath = writeIdl('auto.idl', VFT_EXTENDED_IDL);
      const result = await resolveInitPayload({ payload: '0x', idl: idlPath, args: '["Token", "TK", 18]' });
      expect(result).toMatch(/^0x/);
      expect(result.length).toBeGreaterThan(10);
    });

    it('selects explicit constructor by name', async () => {
      const idlPath = writeIdl('explicit.idl', IDL_MULTI_CTOR);
      const result = await resolveInitPayload({ payload: '0x', idl: idlPath, init: 'New' });
      expect(result).toMatch(/^0x/);
    });

    it('throws CONSTRUCTOR_ARG_MISMATCH for wrong arg count', async () => {
      const idlPath = writeIdl('argcount.idl', VFT_EXTENDED_IDL);
      // VFT New expects 3 args (name, symbol, decimals), pass only 2
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath, args: '["Token", "TK"]' })).rejects.toMatchObject({
        code: 'CONSTRUCTOR_ARG_MISMATCH',
      });
    });

    it('throws CONSTRUCTOR_ARG_MISMATCH for too many args', async () => {
      const idlPath = writeIdl('toomany.idl', VFT_EXTENDED_IDL);
      await expect(resolveInitPayload({ payload: '0x', idl: idlPath, args: '["Token", "TK", 18, "extra"]' })).rejects.toMatchObject({
        code: 'CONSTRUCTOR_ARG_MISMATCH',
      });
    });

    it('encodes with explicit --init and --args', async () => {
      const idlPath = writeIdl('withargs.idl', IDL_MULTI_CTOR);
      const result = await resolveInitPayload({ payload: '0x', idl: idlPath, init: 'FromConfig', args: '[42]' });
      expect(result).toMatch(/^0x/);
      expect(result.length).toBeGreaterThan(4);
    });

    it('auto-converts hex string to byte array for vec u8 constructor arg', async () => {
      const idlWithBytes = `
        type Config = struct {
          name: str,
          data: vec u8,
        };

        constructor {
          New : (config: Config);
        };

        service Foo {
          query Bar : () -> u32;
        };
      `;
      const idlPath = writeIdl('hex-bytes.idl', idlWithBytes);

      // Pass hex string for the vec u8 field — should auto-convert
      const hexResult = await resolveInitPayload({
        payload: '0x',
        idl: idlPath,
        args: '[{"name": "test", "data": "0xaabbcc"}]',
      });
      expect(hexResult).toMatch(/^0x/);

      // Pass explicit byte array — should also work
      const arrayResult = await resolveInitPayload({
        payload: '0x',
        idl: idlPath,
        args: '[{"name": "test", "data": [170, 187, 204]}]',
      });
      expect(arrayResult).toMatch(/^0x/);

      // Both should produce the same encoding
      expect(hexResult).toBe(arrayResult);
    });
  });
});
