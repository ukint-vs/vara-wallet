import { extractSailsIdl } from '../services/wasm-section';

// Minimal valid WASM header: magic '\0asm' + version 1.
const WASM_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

/**
 * Build a minimal valid WASM blob that consists of just the header plus
 * zero or more custom sections. WebAssembly.Module will accept this —
 * all sections (including type/function/etc.) are optional, and custom
 * sections don't participate in validation.
 */
function buildWasm(customSections: Array<{ name: string; payload: Uint8Array }>): Uint8Array {
  const chunks: number[] = [...WASM_HEADER];
  for (const { name, payload } of customSections) {
    const nameBytes = new TextEncoder().encode(name);
    const nameLen = uleb128(nameBytes.length);
    const sectionBodyLen = nameLen.length + nameBytes.length + payload.length;
    chunks.push(0x00); // custom section id
    chunks.push(...uleb128(sectionBodyLen));
    chunks.push(...nameLen);
    chunks.push(...nameBytes);
    chunks.push(...payload);
  }
  return new Uint8Array(chunks);
}

describe('extractSailsIdl', () => {
  const encoder = new TextEncoder();

  it('returns the payload when a sails:idl custom section is present', async () => {
    const idl = 'service Counter { query Value : () -> u32; };';
    const wasm = buildWasm([{ name: 'sails:idl', payload: encoder.encode(idl) }]);
    await expect(extractSailsIdl(wasm)).resolves.toBe(idl);
  });

  it('returns null when no custom sections are present', async () => {
    await expect(extractSailsIdl(WASM_HEADER)).resolves.toBeNull();
  });

  it('returns null when only other-named custom sections exist', async () => {
    const wasm = buildWasm([
      { name: 'name', payload: encoder.encode('irrelevant') },
      { name: 'producers', payload: encoder.encode('also irrelevant') },
    ]);
    await expect(extractSailsIdl(wasm)).resolves.toBeNull();
  });

  it('finds sails:idl among multiple custom sections', async () => {
    const idl = '!@sails: 1.0.0-beta.1\nservice Foo@0x00 {}';
    const wasm = buildWasm([
      { name: 'name', payload: encoder.encode('noise') },
      { name: 'sails:idl', payload: encoder.encode(idl) },
      { name: 'producers', payload: encoder.encode('trailing') },
    ]);
    await expect(extractSailsIdl(wasm)).resolves.toBe(idl);
  });

  it('returns an empty string for an empty sails:idl payload', async () => {
    const wasm = buildWasm([{ name: 'sails:idl', payload: new Uint8Array() }]);
    await expect(extractSailsIdl(wasm)).resolves.toBe('');
  });

  it('rejects on invalid WASM bytes (wrong magic)', async () => {
    const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00]);
    await expect(extractSailsIdl(bad)).rejects.toThrow();
  });

  it('rejects on non-UTF-8 payload in sails:idl', async () => {
    // 0xff is not a valid UTF-8 start byte.
    const wasm = buildWasm([{ name: 'sails:idl', payload: new Uint8Array([0xff, 0xfe, 0xfd]) }]);
    await expect(extractSailsIdl(wasm)).rejects.toThrow();
  });
});
