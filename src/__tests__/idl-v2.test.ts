import * as path from 'path';
import {
  parseIdlFileAuto,
  parseIdlFileV2,
  describeSailsProgram,
  getSailsVersion,
  isSailsV2,
  detectIdlVersion,
} from '../services/sails';
import * as fs from 'fs';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-v2.idl');

describe('IDL v2 façade', () => {
  it('parses the v2 fixture via parseIdlFileV2', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    expect(isSailsV2(program)).toBe(true);
    expect(getSailsVersion(program)).toBe('v2');
    expect(Object.keys(program.services).sort()).toEqual(['Demo']);
  });

  it('auto-detects v2 from the file directive', async () => {
    const idl = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    expect(detectIdlVersion(idl)).toBe('v2');
    const program = await parseIdlFileAuto(FIXTURE_PATH);
    expect(getSailsVersion(program)).toBe('v2');
  });

  it('exposes ctors from the program block', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    if (!isSailsV2(program)) throw new Error('Expected v2');
    expect(program.ctors).not.toBeNull();
    expect(Object.keys(program.ctors!).sort()).toEqual(['Default', 'New']);
  });

  it('exposes functions/queries/events per service', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    if (!isSailsV2(program)) throw new Error('Expected v2');
    const demo = program.services.Demo;
    expect(Object.keys(demo.functions).sort()).toEqual(['Echo', 'SetAction', 'SetMaybe', 'SetPacket']);
    expect(Object.keys(demo.queries).sort()).toEqual(['GetMaybe', 'GetPacket', 'GetPair', 'GetResult']);
    expect(Object.keys(demo.events).sort()).toEqual(['Counted', 'PacketStored', 'Ping']);
  });

  it('describeSailsProgram produces the expected shape', async () => {
    const program = await parseIdlFileAuto(FIXTURE_PATH);
    const desc = describeSailsProgram(program) as Record<string, {
      functions: Record<string, { args: Array<{ name: string; type: string }>; returnType: string; docs: string | null }>;
      queries: Record<string, { args: Array<{ name: string; type: string }>; returnType: string; docs: string | null }>;
      events: Record<string, { type: string; docs: string | null }>;
    }>;

    expect(Object.keys(desc)).toEqual(['Demo']);
    const demo = desc.Demo;

    // Functions: argument and return types rendered as canonical strings.
    expect(demo.functions.Echo.args).toEqual([
      { name: 'data', type: 'Vec<u8>' },
      { name: 'hash', type: '[u8;32]' },
    ]);
    expect(demo.functions.Echo.returnType).toBe('Vec<u8>');
    expect(demo.functions.SetPacket.args).toEqual([{ name: 'packet', type: 'Packet' }]);
    expect(demo.functions.SetMaybe.args).toEqual([{ name: 'maybe', type: 'Option<Packet>' }]);

    // Queries with composite return types.
    expect(demo.queries.GetPair.returnType).toBe('(u32,Packet)');
    expect(demo.queries.GetResult.returnType).toBe('Result<Packet,String>');
    expect(demo.queries.GetMaybe.returnType).toBe('Option<Packet>');

    // Events: pre-rendered type strings from the TypeResolver.
    expect(demo.events.Ping.type).toBe('Null');
    expect(demo.events.PacketStored.type).toBe('Packet');
    expect(demo.events.Counted.type).toBe('u32');

    // Doc strings propagated (v2 IDL supports `///`).
    expect(demo.functions.Echo.docs).toContain('Echo bytes');
    expect(demo.events.PacketStored.docs).toContain('Single unnamed payload');
  });

  it('encodes a ctor payload to non-empty hex', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    if (!isSailsV2(program)) throw new Error('Expected v2');
    const ctor = program.ctors!.New;
    const payload = ctor.encodePayload(42);
    expect(payload).toMatch(/^0x[0-9a-fA-F]+$/);
    // v2 ctor payloads start with a 16-byte SailsMessageHeader prefix.
    expect(payload.length).toBeGreaterThan(2 + 16 * 2);
  });

  it('encodes the zero-arg ctor', async () => {
    const program = await parseIdlFileV2(FIXTURE_PATH);
    if (!isSailsV2(program)) throw new Error('Expected v2');
    const ctor = program.ctors!.Default;
    const payload = ctor.encodePayload();
    expect(payload).toMatch(/^0x[0-9a-fA-F]+$/);
    // Header-only payload: exactly 16 bytes hex-encoded.
    expect(payload).toHaveLength(2 + 16 * 2);
  });
});
