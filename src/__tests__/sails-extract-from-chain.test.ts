import { _tryExtractFromChainForTests } from '../services/sails';
import type { GearApi } from '@gear-js/api';

// Build a minimal valid WASM blob: '\0asm' magic + version 1 + optional
// custom sections. Mirrors the helper in wasm-section.test.ts; duplicated
// here because that helper isn't exported and re-using via cross-test
// imports complicates module resolution.
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

/**
 * Stub Bytes codec. The real @polkadot/types-codec Bytes prepends the SCALE
 * compact-length when toU8a() is called bare; toU8a(true) returns the raw
 * inner bytes. We mimic that exactly: tracking which call shape is used is
 * the entire point of the test (B1 regression: the prefix must NOT leak
 * into extractSailsIdl).
 */
function makeBytesCodec(inner: Uint8Array): {
  toU8a: (isBare?: boolean) => Uint8Array;
  callShapes: Array<boolean | undefined>;
} {
  const callShapes: Array<boolean | undefined> = [];
  return {
    toU8a(isBare?: boolean) {
      callShapes.push(isBare);
      if (isBare === true) return inner;
      // Bare false / undefined: simulate the leaked compact-length prefix.
      // Real polkadot prepends a SCALE compact uint of inner.length.
      // We just prepend an arbitrary 4-byte garbage prefix to make the
      // WASM-magic check fail downstream — the exact bytes don't matter,
      // only that they are NOT the WASM magic.
      const garbage = new Uint8Array([0x4a, 0x43, 0x04, 0x00]);
      const out = new Uint8Array(garbage.length + inner.length);
      out.set(garbage, 0);
      out.set(inner, garbage.length);
      return out;
    },
    callShapes,
  };
}

function makeNoneOption(): { isSome: false } {
  return { isSome: false };
}

function makeSomeOption(bytes: { toU8a: (isBare?: boolean) => Uint8Array }) {
  return {
    isSome: true as const,
    unwrap() {
      return bytes;
    },
  };
}

function makeApi(opts: {
  storage?: () => Promise<unknown>;
  throwOnQuery?: Error;
}): GearApi {
  const originalCodeStorage = opts.throwOnQuery
    ? () => Promise.reject(opts.throwOnQuery)
    : opts.storage ?? (() => Promise.resolve(makeNoneOption()));
  return {
    query: {
      gearProgram: {
        originalCodeStorage,
      },
    },
  } as unknown as GearApi;
}

const FAKE_CODE_ID = '0x' + '11'.repeat(32);

describe('tryExtractFromChain (B1 regression)', () => {
  const encoder = new TextEncoder();

  it('returns the IDL string when WASM has a sails:idl section', async () => {
    const idl = 'service Counter { query Value : () -> u32; };';
    const wasm = buildWasm([{ name: 'sails:idl', payload: encoder.encode(idl) }]);
    const codec = makeBytesCodec(wasm);
    const api = makeApi({ storage: async () => makeSomeOption(codec) });

    const result = await _tryExtractFromChainForTests(api, FAKE_CODE_ID);
    expect(result).toBe(idl);
    // The fix: the function MUST call toU8a(true) to strip the SCALE prefix.
    // If this asserts toU8a was called bare (undefined or false), the magic
    // check would have failed and the test would not have reached this line —
    // but we assert it explicitly to make the regression intent visible.
    expect(codec.callShapes).toEqual([true]);
  });

  it('returns null when WASM has no sails:idl section (clean fallthrough, no IDL_PARSE_ERROR)', async () => {
    const wasm = buildWasm([
      { name: 'name', payload: encoder.encode('noise') },
      { name: 'producers', payload: encoder.encode('also noise') },
    ]);
    const codec = makeBytesCodec(wasm);
    const api = makeApi({ storage: async () => makeSomeOption(codec) });

    const result = await _tryExtractFromChainForTests(api, FAKE_CODE_ID);
    expect(result).toBeNull();
    expect(codec.callShapes).toEqual([true]);
  });

  it('returns null when originalCodeStorage returns None (no entry)', async () => {
    const api = makeApi({ storage: async () => makeNoneOption() });

    const result = await _tryExtractFromChainForTests(api, FAKE_CODE_ID);
    expect(result).toBeNull();
  });

  it('returns null when originalCodeStorage RPC throws (network/auth/etc.)', async () => {
    const api = makeApi({ throwOnQuery: new Error('connection reset') });

    const result = await _tryExtractFromChainForTests(api, FAKE_CODE_ID);
    expect(result).toBeNull();
  });

  it('regression: bytes passed to extractSailsIdl start with WASM magic 00 61 73 6d', async () => {
    // Negative-control: if the implementation regresses to toU8a() (bare),
    // the bytes seen by extractSailsIdl will start with the garbage prefix
    // and the WASM-magic check will throw IDL_PARSE_ERROR. This test asserts
    // the happy-path returns successfully — i.e., the bytes that reached
    // extractSailsIdl had a valid WASM magic. The toU8a call-shape assertion
    // in the first test is the direct check; this test is the end-to-end
    // assertion that the contract holds.
    const idl = '!@sails: 1.0.0-beta.1\nservice Foo@0x00 {}';
    const wasm = buildWasm([{ name: 'sails:idl', payload: encoder.encode(idl) }]);
    const codec = makeBytesCodec(wasm);
    const api = makeApi({ storage: async () => makeSomeOption(codec) });

    await expect(_tryExtractFromChainForTests(api, FAKE_CODE_ID)).resolves.toBe(idl);
  });
});
