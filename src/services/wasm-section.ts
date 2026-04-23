/**
 * Extract the `sails:idl` custom section from a Gear program's WASM blob.
 *
 * sails-js >= 1.0.0-beta.1 embeds the IDL as a WASM custom section named
 * `sails:idl` (see sails/rs/idl-embed/src/lib.rs). For any v2 program whose
 * code is on-chain, this gives a deterministic IDL source without needing
 * a registry or out-of-band file.
 *
 * Implementation uses Node's built-in `WebAssembly.Module.customSections()`
 * (available since Node 11; package.json requires >=20). Trades a full-
 * module compile (tens to low-hundreds of ms on typical hundreds-of-KB
 * WASMs) for zero maintenance surface vs a hand-written binary parser or
 * a `wasmparser` dependency.
 */

const SECTION_NAME = 'sails:idl';

/**
 * Returns the UTF-8 decoded IDL text from the `sails:idl` custom section,
 * or `null` if the section is absent (e.g. v1 program, or sails < 1.0.0-beta.1).
 *
 * Throws when:
 * - `WebAssembly.Module` rejects the bytes as not a valid WASM module.
 * - The `sails:idl` payload is not valid UTF-8 (fatal TextDecoder) —
 *   a corrupt section is a real bug worth surfacing, not silent fallback.
 */
export function extractSailsIdl(wasm: Uint8Array): string | null {
  // Copy into a fresh ArrayBuffer-backed view so `WebAssembly.Module` is
  // happy regardless of whether the caller's buffer is ArrayBuffer or
  // SharedArrayBuffer (TS's BufferSource type only accepts the former).
  const bytes = new Uint8Array(wasm);
  const mod = new WebAssembly.Module(bytes);
  const sections = WebAssembly.Module.customSections(mod, SECTION_NAME);
  if (sections.length === 0) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(sections[0]);
}
