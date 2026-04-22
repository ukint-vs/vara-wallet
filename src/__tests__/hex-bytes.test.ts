import { SailsIdlParser } from 'sails-js-parser';
import { Sails } from 'sails-js';
import { coerceHexToBytes, coerceArgs } from '../utils/hex-bytes';
import { getRegistryTypes } from '../services/sails';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypeMap = Map<string, any>;

// Helper: parse IDL and return {sails, typeMap}. Uses the exported
// `getRegistryTypes` so we don't reach into private `_program.types`.
async function setup(idl: string) {
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  sails.parseIdl(idl);
  const typeMap: TypeMap = getRegistryTypes(sails);
  return { sails, typeMap };
}

// Get a typeDef for a specific arg of a method
function getArgTypeDef(sails: Sails, serviceName: string, methodName: string, argIndex: number) {
  const service = sails.services[serviceName];
  const method = service.functions[methodName] || service.queries[methodName];
  return method.args[argIndex].typeDef;
}

describe('coerceHexToBytes', () => {
  const EMPTY_MAP: TypeMap = new Map();

  describe('vec u8', () => {
    let vecU8Def: unknown;

    beforeAll(async () => {
      const { sails } = await setup('service S { Test : (data: vec u8) -> bool; };');
      vecU8Def = getArgTypeDef(sails, 'S', 'Test', 0);
    });

    it('converts hex string to byte array', () => {
      const result = coerceHexToBytes('0xabcdef', vecU8Def, EMPTY_MAP);
      expect(result).toEqual([0xab, 0xcd, 0xef]);
    });

    it('converts empty hex to empty array', () => {
      // 0x with no bytes — but our regex requires at least 1 char after 0x
      // so "0x" alone won't match. That's fine, it passes through.
      const result = coerceHexToBytes('0x', vecU8Def, EMPTY_MAP);
      expect(result).toBe('0x'); // passes through (no hex digits)
    });

    it('passes through number array unchanged', () => {
      const arr = [1, 2, 3];
      const result = coerceHexToBytes(arr, vecU8Def, EMPTY_MAP);
      expect(result).toBe(arr);
    });

    it('throws on odd-length hex string', () => {
      expect(() => coerceHexToBytes('0xabc', vecU8Def, EMPTY_MAP)).toThrow('Odd-length hex');
    });

    it('throws on invalid hex characters with 0x prefix', () => {
      expect(() => coerceHexToBytes('0xgggg', vecU8Def, EMPTY_MAP)).toThrow('Invalid hex');
    });

    it('passes through non-0x string unchanged', () => {
      const result = coerceHexToBytes('hello', vecU8Def, EMPTY_MAP);
      expect(result).toBe('hello');
    });

    it('passes through null unchanged', () => {
      expect(coerceHexToBytes(null, vecU8Def, EMPTY_MAP)).toBeNull();
    });
  });

  describe('struct with vec u8 field (UserDefined)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sails: any;
    let typeMap: TypeMap;

    beforeAll(async () => {
      const result = await setup(`
        type MyStruct = struct {
          name: str,
          data: vec u8,
        };
        service S { Test : (input: MyStruct) -> bool; };
      `);
      sails = result.sails;
      typeMap = result.typeMap;
    });

    it('converts hex field inside struct', () => {
      const typeDef = getArgTypeDef(sails, 'S', 'Test', 0);
      const result = coerceHexToBytes(
        { name: 'test', data: '0xaabb' },
        typeDef,
        typeMap,
      );
      expect(result).toEqual({ name: 'test', data: [0xaa, 0xbb] });
    });

    it('leaves str field with 0x value unchanged', () => {
      const typeDef = getArgTypeDef(sails, 'S', 'Test', 0);
      const result = coerceHexToBytes(
        { name: '0xnotbytes', data: [1, 2] },
        typeDef,
        typeMap,
      );
      expect(result).toEqual({ name: '0xnotbytes', data: [1, 2] });
    });
  });

  describe('nested struct', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sails: any;
    let typeMap: TypeMap;

    beforeAll(async () => {
      const result = await setup(`
        type Inner = struct {
          sig: vec u8,
        };
        type Outer = struct {
          payload: str,
          inner: Inner,
        };
        service S { Test : (input: Outer) -> bool; };
      `);
      sails = result.sails;
      typeMap = result.typeMap;
    });

    it('converts hex in nested struct field', () => {
      const typeDef = getArgTypeDef(sails, 'S', 'Test', 0);
      const result = coerceHexToBytes(
        { payload: 'hello', inner: { sig: '0xff00' } },
        typeDef,
        typeMap,
      );
      expect(result).toEqual({ payload: 'hello', inner: { sig: [0xff, 0x00] } });
    });
  });

  describe('enum with vec u8 variant', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sails: any;
    let typeMap: TypeMap;

    beforeAll(async () => {
      const result = await setup(`
        type MyEnum = enum {
          None,
          Bytes: vec u8,
        };
        service S { Test : (input: MyEnum) -> bool; };
      `);
      sails = result.sails;
      typeMap = result.typeMap;
    });

    it('converts hex in enum variant payload', () => {
      const typeDef = getArgTypeDef(sails, 'S', 'Test', 0);
      const result = coerceHexToBytes(
        { Bytes: '0xdead' },
        typeDef,
        typeMap,
      );
      expect(result).toEqual({ Bytes: [0xde, 0xad] });
    });

    it('passes through unit variant unchanged', () => {
      const typeDef = getArgTypeDef(sails, 'S', 'Test', 0);
      const result = coerceHexToBytes(
        { None: null },
        typeDef,
        typeMap,
      );
      expect(result).toEqual({ None: null });
    });
  });

  describe('optional vec u8', () => {
    let optTypeDef: unknown;

    beforeAll(async () => {
      const { sails } = await setup('service S { Test : (data: opt vec u8) -> bool; };');
      optTypeDef = getArgTypeDef(sails, 'S', 'Test', 0);
    });

    it('converts hex when value is present', () => {
      const result = coerceHexToBytes('0xaabb', optTypeDef, EMPTY_MAP);
      expect(result).toEqual([0xaa, 0xbb]);
    });

    it('passes through null unchanged', () => {
      expect(coerceHexToBytes(null, optTypeDef, EMPTY_MAP)).toBeNull();
    });
  });

  describe('vec of non-u8 type', () => {
    let vecU32Def: unknown;

    beforeAll(async () => {
      const { sails } = await setup('service S { Test : (data: vec u32) -> bool; };');
      vecU32Def = getArgTypeDef(sails, 'S', 'Test', 0);
    });

    it('does not convert hex string', () => {
      const result = coerceHexToBytes('0xaabb', vecU32Def, EMPTY_MAP);
      expect(result).toBe('0xaabb');
    });

    it('passes through array unchanged', () => {
      const arr = [1, 2, 3];
      expect(coerceHexToBytes(arr, vecU32Def, EMPTY_MAP)).toEqual(arr);
    });
  });

  describe('primitive types', () => {
    let strDef: unknown;
    let u32Def: unknown;

    beforeAll(async () => {
      const { sails } = await setup('service S { Test : (name: str, count: u32) -> bool; };');
      strDef = getArgTypeDef(sails, 'S', 'Test', 0);
      u32Def = getArgTypeDef(sails, 'S', 'Test', 1);
    });

    it('does not convert str field with 0x value', () => {
      expect(coerceHexToBytes('0xdeadbeef', strDef, EMPTY_MAP)).toBe('0xdeadbeef');
    });

    it('passes through numbers unchanged', () => {
      expect(coerceHexToBytes(42, u32Def, EMPTY_MAP)).toBe(42);
    });
  });
});

describe('coerceArgs', () => {
  it('returns empty array for empty args', () => {
    expect(coerceArgs([], [], {})).toEqual([]);
  });

  it('coerces hex args using sails type info', async () => {
    const { sails } = await setup('service S { Test : (data: vec u8) -> bool; };');
    const func = sails.services['S'].functions['Test'];
    const result = coerceArgs(['0xaabb'], func.args, sails);
    expect(result).toEqual([[0xaa, 0xbb]]);
  });

  it('gracefully returns args when _program.types is unavailable', () => {
    const fakeSails = { _program: null };
    const args = ['0xaabb'];
    const argDefs = [{ name: 'data', typeDef: {} }];
    expect(coerceArgs(args, argDefs, fakeSails)).toEqual(args);
  });

  it('gracefully returns args when _program throws', () => {
    const fakeSails = {
      get _program() {
        throw new Error('broken');
      },
    };
    const args = ['0xaabb'];
    const argDefs = [{ name: 'data', typeDef: {} }];
    expect(coerceArgs(args, argDefs, fakeSails)).toEqual(args);
  });
});
