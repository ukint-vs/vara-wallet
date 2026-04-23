/**
 * Two services declaring same-named user types must not collide in arg
 * coercion. Scoping via `serviceName` narrows the type map to the
 * caller's service plus program-level types.
 */
import * as path from 'path';
import { parseIdlFileV2, getRegistryTypes } from '../services/sails';
import { coerceArgsV2 } from '../utils/hex-bytes';

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-collision.idl');

describe('v2 type scoping across services', () => {
  it('getRegistryTypes with a service name returns only that service\'s types', async () => {
    const program = await parseIdlFileV2(FIXTURE);

    const aMap = getRegistryTypes(program, 'A');
    const bMap = getRegistryTypes(program, 'B');
    const flat = getRegistryTypes(program);

    // Each scoped map has its own Packet definition.
    const aPacket = aMap.get('Packet');
    const bPacket = bMap.get('Packet');
    expect(aPacket).toBeDefined();
    expect(bPacket).toBeDefined();
    expect(aPacket).not.toBe(bPacket);

    // Service A's Packet has [u8; 4], service B's has [u8; 8].
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aLen = aPacket.fields[0].type.len as number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bLen = bPacket.fields[0].type.len as number;
    expect(aLen).toBe(4);
    expect(bLen).toBe(8);

    // Un-scoped flat map collides — last-service-iterated wins.
    expect(flat.get('Packet')).toBeDefined();
  });

  it('coerceArgsV2 with service name uses that service\'s type shape', async () => {
    const program = await parseIdlFileV2(FIXTURE);

    const aSet = program.services.A.functions.Set;
    const bSet = program.services.B.functions.Set;

    // A expects 4 bytes. 4-byte hex should coerce cleanly; 8-byte
    // should throw the length-mismatch error.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coerceArgsV2([{ payload: '0x01020304' }], aSet.args as any, program, 'A'),
    ).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coerceArgsV2([{ payload: '0x0102030405060708' }], aSet.args as any, program, 'A'),
    ).toThrow(/\[u8; 4\]/);

    // B expects 8 bytes — opposite result.
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coerceArgsV2([{ payload: '0x0102030405060708' }], bSet.args as any, program, 'B'),
    ).not.toThrow();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      coerceArgsV2([{ payload: '0x01020304' }], bSet.args as any, program, 'B'),
    ).toThrow(/\[u8; 8\]/);
  });

  it('getRegistryTypes memoizes results per (instance, scope) pair', async () => {
    const program = await parseIdlFileV2(FIXTURE);
    const first = getRegistryTypes(program, 'A');
    const second = getRegistryTypes(program, 'A');
    // Same Map reference on second call — cached.
    expect(first).toBe(second);
    // Different scope, different Map.
    expect(getRegistryTypes(program, 'B')).not.toBe(first);
  });
});
