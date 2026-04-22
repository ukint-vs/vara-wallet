import * as path from 'path';
import { parseIdlFileV2, describeType } from '../services/sails';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-v2.idl');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function load(): Promise<any> {
  return parseIdlFileV2(FIXTURE_PATH);
}

describe('describeType (v2)', () => {
  it('renders primitives as their literal names', async () => {
    const program = await load();
    expect(describeType(program, 'u32')).toBe('u32');
    expect(describeType(program, 'String')).toBe('String');
    expect(describeType(program, 'bool')).toBe('bool');
    // TypeResolver unwraps ActorId → underlying [u8;32] representation.
    expect(describeType(program, 'ActorId')).toBe('[u8;32]');
  });

  it('renders Vec<u8> from slice shape', async () => {
    const program = await load();
    const typeDef = { kind: 'slice', item: 'u8' };
    expect(describeType(program, typeDef)).toBe('Vec<u8>');
  });

  it('renders [u8; 32] from array shape', async () => {
    const program = await load();
    const typeDef = { kind: 'array', item: 'u8', len: 32 };
    expect(describeType(program, typeDef)).toBe('[u8;32]');
  });

  it('renders tuples', async () => {
    const program = await load();
    const typeDef = { kind: 'tuple', types: ['u32', 'String'] };
    expect(describeType(program, typeDef)).toBe('(u32,String)');
  });

  it('renders Option<T> as a named wrapper', async () => {
    const program = await load();
    const typeDef = { kind: 'named', name: 'Option', generics: ['u32'] };
    expect(describeType(program, typeDef)).toBe('Option<u32>');
  });

  it('renders Result<T, E> as a named wrapper', async () => {
    const program = await load();
    const typeDef = { kind: 'named', name: 'Result', generics: ['String', 'String'] };
    expect(describeType(program, typeDef)).toBe('Result<String,String>');
  });

  it('renders nested composites (Option<Vec<u8>>)', async () => {
    const program = await load();
    const typeDef = {
      kind: 'named',
      name: 'Option',
      generics: [{ kind: 'slice', item: 'u8' }],
    };
    expect(describeType(program, typeDef)).toBe('Option<Vec<u8>>');
  });

  it('renders user-defined struct by name', async () => {
    const program = await load();
    const typeDef = { kind: 'named', name: 'Packet' };
    expect(describeType(program, typeDef)).toBe('Packet');
  });

  it('renders user-defined enum by name', async () => {
    const program = await load();
    const typeDef = { kind: 'named', name: 'Action' };
    expect(describeType(program, typeDef)).toBe('Action');
  });

  it('returns "unknown" for unresolvable input', async () => {
    const program = await load();
    // A malformed TypeDecl the TypeResolver can't parse.
    expect(describeType(program, { kind: 'bogus' } as unknown)).toBe('unknown');
  });

  it('matches the pre-rendered .type string on method args', async () => {
    const program = await load();
    const echo = program.services.Demo.functions.Echo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [dataArg, hashArg] = echo.args as Array<{ type: string; typeDef: any }>;
    expect(describeType(program, dataArg.typeDef)).toBe(dataArg.type);
    expect(describeType(program, hashArg.typeDef)).toBe(hashArg.type);
  });
});
