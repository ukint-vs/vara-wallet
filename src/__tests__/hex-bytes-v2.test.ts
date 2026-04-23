import * as path from 'path';
import { parseIdlFileV2 } from '../services/sails';
import { coerceHexToBytesV2, coerceArgsV2, coerceArgsAuto } from '../utils/hex-bytes';
import type { SailsProgram } from 'sails-js';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-v2.idl');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V2TypeMap = Map<string, any>;

async function setupProgram() {
  const program = await parseIdlFileV2(FIXTURE_PATH);
  // Types in v2 live per-service (doc.services[i].types) plus optional
  // ambient types on doc.program.types. Merge both into a single map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (program as any)._doc;
  const typeMap: V2TypeMap = new Map();
  for (const t of doc?.program?.types ?? []) typeMap.set(t.name, t);
  for (const svc of doc?.services ?? []) {
    for (const t of svc.types ?? []) typeMap.set(t.name, t);
  }
  return { program, typeMap };
}

// Get the TypeDecl for a specific arg of a specific method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function argType(program: SailsProgram, service: string, method: string, argIndex: number): any {
  const m = program.services[service].functions[method] ?? program.services[service].queries[method];
  return (m.args[argIndex] as { typeDef: unknown }).typeDef;
}

describe('coerceHexToBytesV2', () => {
  const EMPTY_MAP: V2TypeMap = new Map();

  describe('Vec<u8> slice', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let dataType: any;
    beforeAll(async () => {
      const { program } = await setupProgram();
      dataType = argType(program, 'Demo', 'Echo', 0);
    });

    it('converts hex string to byte array', () => {
      expect(coerceHexToBytesV2('0xabcdef', dataType, EMPTY_MAP)).toEqual([0xab, 0xcd, 0xef]);
    });

    it('passes through 0x with no hex digits', () => {
      expect(coerceHexToBytesV2('0x', dataType, EMPTY_MAP)).toBe('0x');
    });

    it('throws on odd-length hex', () => {
      expect(() => coerceHexToBytesV2('0xabc', dataType, EMPTY_MAP)).toThrow(/Odd-length/);
    });

    it('throws on invalid hex characters', () => {
      expect(() => coerceHexToBytesV2('0xzz', dataType, EMPTY_MAP)).toThrow(/Invalid hex/);
    });

    it('passes through non-string values unchanged', () => {
      expect(coerceHexToBytesV2([1, 2, 3], dataType, EMPTY_MAP)).toEqual([1, 2, 3]);
    });
  });

  describe('[u8; 32] fixed array', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let hashType: any;
    beforeAll(async () => {
      const { program } = await setupProgram();
      hashType = argType(program, 'Demo', 'Echo', 1);
    });

    it('converts correct-length hex to bytes', () => {
      const hex = '0x' + '11'.repeat(32);
      const bytes = coerceHexToBytesV2(hex, hashType, EMPTY_MAP) as number[];
      expect(bytes).toHaveLength(32);
      expect(bytes[0]).toBe(0x11);
    });

    it('throws on wrong-length hex', () => {
      expect(() => coerceHexToBytesV2('0xaa', hashType, EMPTY_MAP)).toThrow(/\[u8; 32\]/);
    });
  });

  describe('struct with byte fields', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let packetType: any;
    let typeMap: V2TypeMap;
    beforeAll(async () => {
      const setup = await setupProgram();
      typeMap = setup.typeMap;
      packetType = argType(setup.program, 'Demo', 'SetPacket', 0);
    });

    it('recurses into named struct and coerces byte fields', () => {
      const input = { id: 42, payload: '0xabcd', tag: '0x' + '77'.repeat(8) };
      const out = coerceHexToBytesV2(input, packetType, typeMap) as {
        id: number;
        payload: number[];
        tag: number[];
      };
      expect(out.id).toBe(42);
      expect(out.payload).toEqual([0xab, 0xcd]);
      expect(out.tag).toHaveLength(8);
    });

    it('throws with field name hint when tag length is wrong', () => {
      const input = { id: 1, payload: '0x', tag: '0xff' };
      expect(() => coerceHexToBytesV2(input, packetType, typeMap)).toThrow(/"tag"/);
    });
  });

  describe('Option<Packet>', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let maybeType: any;
    let typeMap: V2TypeMap;
    beforeAll(async () => {
      const setup = await setupProgram();
      typeMap = setup.typeMap;
      maybeType = argType(setup.program, 'Demo', 'SetMaybe', 0);
    });

    it('recurses into Option<T> payload', () => {
      const input = { id: 1, payload: '0xaa', tag: '0x' + '00'.repeat(8) };
      const out = coerceHexToBytesV2(input, maybeType, typeMap) as {
        payload: number[];
      };
      expect(out.payload).toEqual([0xaa]);
    });

    it('passes through null without error', () => {
      expect(coerceHexToBytesV2(null, maybeType, typeMap)).toBeNull();
    });
  });

  describe('enum variant recursion', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let actionType: any;
    let typeMap: V2TypeMap;
    beforeAll(async () => {
      const setup = await setupProgram();
      typeMap = setup.typeMap;
      actionType = argType(setup.program, 'Demo', 'SetAction', 0);
    });

    it('unit variant passes through unchanged', () => {
      const input = { Noop: null };
      expect(coerceHexToBytesV2(input, actionType, typeMap)).toEqual(input);
    });

    it('variant with unnamed [u8; 4] payload coerces hex', () => {
      const out = coerceHexToBytesV2({ Tag: '0xdeadbeef' }, actionType, typeMap) as { Tag: number[] };
      expect(out.Tag).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it('variant with struct-shaped payload recurses fields', () => {
      const out = coerceHexToBytesV2(
        { Store: { key: 'foo', value: '0x0102' } },
        actionType,
        typeMap,
      ) as { Store: { key: string; value: number[] } };
      expect(out.Store.key).toBe('foo');
      expect(out.Store.value).toEqual([0x01, 0x02]);
    });
  });

  describe('primitive passthrough', () => {
    it('u32 primitive passes through', () => {
      // Build a synthetic primitive TypeDecl (string literal in v2).
      expect(coerceHexToBytesV2(42, 'u32', EMPTY_MAP)).toBe(42);
      expect(coerceHexToBytesV2('hi', 'String', EMPTY_MAP)).toBe('hi');
    });

    it('null/undefined pass through', () => {
      expect(coerceHexToBytesV2(null, 'u32', EMPTY_MAP)).toBeNull();
      expect(coerceHexToBytesV2(undefined, 'u32', EMPTY_MAP)).toBeUndefined();
    });
  });
});

describe('ActorId primitive', () => {
  const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
  const ALICE_HEX = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  const EMPTY_MAP: V2TypeMap = new Map();

  it('accepts canonical hex unchanged', () => {
    expect(coerceHexToBytesV2(ALICE_HEX, 'ActorId', EMPTY_MAP)).toBe(ALICE_HEX);
  });

  it('converts SS58 to canonical hex', () => {
    expect(coerceHexToBytesV2(ALICE_SS58, 'ActorId', EMPTY_MAP)).toBe(ALICE_HEX);
  });

  it('throws on garbage string', () => {
    expect(() => coerceHexToBytesV2('not-an-address', 'ActorId', EMPTY_MAP)).toThrow(/Invalid ActorId/);
  });

  it('throws on wrong-length hex (20-byte Ethereum-style)', () => {
    expect(() => coerceHexToBytesV2('0x1234567890123456789012345678901234567890', 'ActorId', EMPTY_MAP))
      .toThrow(/Invalid ActorId/);
  });

  it('passes through non-string unchanged', () => {
    const preDecoded = Array.from({ length: 32 }, (_, i) => i);
    expect(coerceHexToBytesV2(preDecoded, 'ActorId', EMPTY_MAP)).toBe(preDecoded);
  });

  it('coerces SS58 inside a struct field (walker recursion)', () => {
    const typeMap: V2TypeMap = new Map([
      [
        'Transfer',
        {
          kind: 'struct',
          name: 'Transfer',
          fields: [
            { name: 'to', type: 'ActorId' },
            { name: 'amount', type: 'u128' },
          ],
        },
      ],
    ]);
    const result = coerceHexToBytesV2(
      { to: ALICE_SS58, amount: 100 },
      { kind: 'named', name: 'Transfer' },
      typeMap,
    );
    expect(result).toEqual({ to: ALICE_HEX, amount: 100 });
  });
});

describe('coerceArgsV2', () => {
  it('coerces method args based on IDL types', async () => {
    const { program } = await setupProgram();
    const echo = program.services.Demo.functions.Echo;
    const args = coerceArgsV2(
      ['0xabcdef', '0x' + '11'.repeat(32)],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      echo.args as any,
      program,
    );
    expect(args[0]).toEqual([0xab, 0xcd, 0xef]);
    expect((args[1] as number[]).length).toBe(32);
  });

  it('returns args unchanged when types map is missing', () => {
    const fakeProgram = {} as SailsProgram;
    const args = coerceArgsV2(['foo'], [{ name: 'x', typeDef: 'String' }], fakeProgram);
    expect(args).toEqual(['foo']);
  });

  it('returns empty args array unchanged', async () => {
    const { program } = await setupProgram();
    expect(coerceArgsV2([], [], program)).toEqual([]);
  });
});

describe('coerceArgsAuto dispatch', () => {
  it('routes v2 SailsProgram to the v2 walker', async () => {
    const { program } = await setupProgram();
    const echo = program.services.Demo.functions.Echo;
    const args = coerceArgsAuto(
      ['0xabcdef', '0x' + '11'.repeat(32)],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      echo.args as any,
      program,
    );
    expect(args[0]).toEqual([0xab, 0xcd, 0xef]);
  });
});
