import { GearApi } from '@gear-js/api';
import { Sails, SailsProgram } from 'sails-js';
import { SailsIdlParser as V1Parser } from 'sails-js-parser';
import { SailsIdlParser as V2Parser } from 'sails-js/parser';
import * as fs from 'fs';
import { CliError, verbose, addressToHex } from '../utils';
import { readConfig } from './config';
import { BUNDLED_VFT_IDLS } from '../idl/bundled-idls';

export type LoadedSails = Sails | SailsProgram;
/**
 * Outcome of the text-level IDL version probe.
 *
 * - `'v2'` — the IDL source starts with a `!@sails:` directive.
 * - `'unknown'` — no directive present. v1 IDLs, malformed IDLs, and
 *   (hypothetically) a v2 IDL served without the header all land here;
 *   callers disambiguate by trying the v1 parser first and falling
 *   back to v2.
 *
 * Note: the probe never returns `'v1'` directly because v1 IDLs carry
 * no version marker. Treating the v1 case as `'unknown'` keeps the
 * parser-try fallback as the single source of truth.
 */
export type IdlVersion = 'v2' | 'unknown';

let v1ParserPromise: Promise<V1Parser> | null = null;
let v2ParserPromise: Promise<V2Parser> | null = null;

/**
 * Lazily instantiate a parser and cache the in-flight promise so callers
 * share one initialization. If init rejects we reset the slot to null so
 * the next caller can retry — otherwise a transient WASM-decompression
 * hiccup would leave the process permanently wedged on a rejected
 * promise.
 */
async function memoParser<T>(slot: () => Promise<T> | null, set: (p: Promise<T> | null) => void, init: () => Promise<T>): Promise<T> {
  let promise = slot();
  if (!promise) {
    promise = init();
    set(promise);
    promise.catch(() => set(null));
  }
  return promise;
}

async function getV1Parser(): Promise<V1Parser> {
  return memoParser(
    () => v1ParserPromise,
    (p) => { v1ParserPromise = p; },
    () => V1Parser.new(),
  );
}

async function getV2Parser(): Promise<V2Parser> {
  return memoParser(
    () => v2ParserPromise,
    (p) => { v2ParserPromise = p; },
    async () => {
      const parser = new V2Parser();
      await parser.init();
      return parser;
    },
  );
}

/**
 * Test-only helper: clear the cached parser promises. Not exported via
 * utils/index.ts because callers outside of tests should never need it.
 */
export function _resetParserCache(): void {
  v1ParserPromise = null;
  v2ParserPromise = null;
}

/**
 * Detect IDL version from the source text.
 *
 * v2 IDLs start with a `!@sails: <version>` directive. v1 IDLs have no
 * version marker. Returns 'unknown' when absent — callers should attempt
 * v1 parse first (no WASM init), then fall back to v2 on failure.
 */
export function detectIdlVersion(idlText: string): IdlVersion {
  if (/^\s*!@sails:\s*/m.test(idlText)) return 'v2';
  return 'unknown';
}

export interface SailsSetupOptions {
  idl?: string;
  programId: string;
  /** Optional validator for bundled IDL fallback. When provided, bundled IDLs
   *  are tried as a last resort; the validator must return true for the IDL to be accepted.
   *  Callers typically check that the required method exists in some service.
   *
   *  v1 only — bundled fallback is not supported on v2. */
  idlValidator?: (sails: Sails) => boolean;
  /** Optional bundled IDL strings to try as fallback. When provided, these are used
   *  instead of the default VFT bundled IDLs. Requires idlValidator to be set. */
  bundledIdls?: string[];
}

/**
 * Load a v1 Sails IDL and return a configured Sails instance.
 *
 * IDL resolution cascade:
 * 1. --idl <path> flag (local file)
 * 2. Remote fetch from meta-storage using program's codeId
 * 3. Bundled IDL fallback (only when idlValidator is provided)
 */
export async function loadSailsV1(
  api: GearApi,
  options: SailsSetupOptions,
): Promise<Sails> {
  const parser = await getV1Parser();
  const sails = new Sails(parser);

  const programId = addressToHex(options.programId);
  const idlString = await resolveIdl(api, { ...options, programId }, parser);
  sails.parseIdl(idlString);
  sails.setApi(api);
  sails.setProgramId(programId);

  return sails;
}

/**
 * Load a v2 Sails IDL and return a configured SailsProgram instance.
 *
 * Same IDL resolution cascade as loadSailsV1, minus the bundled fallback
 * (no bundled v2 IDLs ship with vara-wallet).
 */
export async function loadSailsV2(
  api: GearApi,
  options: SailsSetupOptions,
): Promise<SailsProgram> {
  const parser = await getV2Parser();
  const programId = addressToHex(options.programId);
  const idlString = await resolveIdl(api, { ...options, programId }, null);
  const doc = parser.parse(idlString);
  const program = new SailsProgram(doc);
  program.setApi(api);
  program.setProgramId(programId);
  return program;
}

/**
 * Load a Sails IDL, auto-detecting version.
 *
 * Detection strategy: text marker first, then parser-try fallback.
 * If the IDL has no `!@sails:` directive, we try v1 first (no WASM init cost)
 * and fall back to v2 on parse failure, preserving both error messages.
 */
export async function loadSailsAuto(
  api: GearApi,
  options: SailsSetupOptions,
): Promise<LoadedSails> {
  // Bundled fallback path is v1-only. If the caller provided a validator,
  // stay on the v1 loader so existing vft/dex flows keep working.
  if (options.idlValidator) {
    return loadSailsV1(api, options);
  }

  const programId = addressToHex(options.programId);
  const idlString = await resolveIdl(api, { ...options, programId }, null);
  const version = detectIdlVersion(idlString);

  if (version === 'v2') {
    return buildV2FromIdl(api, programId, idlString);
  }

  // 'unknown' — try v1 first (no WASM init), fall back to v2.
  try {
    return await buildV1FromIdl(api, programId, idlString);
  } catch (v1Err) {
    try {
      return await buildV2FromIdl(api, programId, idlString);
    } catch (v2Err) {
      const v1Msg = v1Err instanceof Error ? v1Err.message : String(v1Err);
      const v2Msg = v2Err instanceof Error ? v2Err.message : String(v2Err);
      throw new CliError(
        `IDL parse failed on both v1 and v2 parsers.\n  v1: ${v1Msg}\n  v2: ${v2Msg}`,
        'IDL_PARSE_ERROR',
      );
    }
  }
}

async function buildV1FromIdl(api: GearApi, programId: `0x${string}`, idlString: string): Promise<Sails> {
  const parser = await getV1Parser();
  const sails = new Sails(parser);
  sails.parseIdl(idlString);
  sails.setApi(api);
  sails.setProgramId(programId);
  return sails;
}

async function buildV2FromIdl(api: GearApi, programId: `0x${string}`, idlString: string): Promise<SailsProgram> {
  const parser = await getV2Parser();
  let program: SailsProgram;
  try {
    const doc = parser.parse(idlString);
    program = new SailsProgram(doc);
  } catch (err) {
    throw new CliError(
      `Failed to parse IDL: ${err instanceof Error ? err.message : String(err)}`,
      'IDL_PARSE_ERROR',
    );
  }
  program.setApi(api);
  program.setProgramId(programId);
  return program;
}

/**
 * @deprecated Use loadSailsV1 directly (for vft/dex flows with bundled IDLs) or
 * loadSailsAuto (for generic flows). Alias preserved to keep vft.ts/dex.ts stable.
 */
export const loadSails = loadSailsV1;

async function resolveIdl(
  api: GearApi,
  options: SailsSetupOptions,
  parser: V1Parser | null,
): Promise<string> {
  // 1. Local file
  if (options.idl) {
    verbose(`Loading IDL from file: ${options.idl}`);
    try {
      return fs.readFileSync(options.idl, 'utf-8');
    } catch {
      throw new CliError(`Failed to read IDL file: ${options.idl}`, 'IDL_FILE_ERROR');
    }
  }

  // 2. Remote fetch via meta-storage
  const config = readConfig();
  const metaStorageUrl = process.env.VARA_META_STORAGE || config.metaStorageUrl;
  let metaStorageError: Error | null = null;

  if (metaStorageUrl) {
    verbose(`Fetching IDL from meta-storage for program ${options.programId}`);
    try {
      const codeId = await api.program.codeId(options.programId);
      verbose(`Program codeId: ${codeId}`);

      const url = `${metaStorageUrl}/sails?codeId=${codeId}`;
      verbose(`Fetching IDL from ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        throw new CliError(
          `Meta-storage returned ${response.status}: ${response.statusText}`,
          'META_STORAGE_ERROR',
        );
      }
      const data = await response.json() as { result?: string; idl?: string };
      const idl = data.result || data.idl;
      if (!idl) {
        throw new CliError(
          `No IDL found in meta-storage`,
          'IDL_NOT_FOUND',
        );
      }
      return idl;
    } catch (err) {
      metaStorageError = err instanceof Error ? err : new Error(String(err));
      verbose(`Meta-storage failed: ${metaStorageError.message}`);
    }
  }

  // 3. Bundled IDL fallback (v1 only; requires validator + v1 parser).
  if (options.idlValidator && parser) {
    const idlsToTry = options.bundledIdls ?? BUNDLED_VFT_IDLS;
    verbose('Trying bundled IDLs as fallback...');
    for (const bundledIdl of idlsToTry) {
      try {
        const probe = new Sails(parser);
        probe.parseIdl(bundledIdl);
        if (options.idlValidator(probe)) {
          verbose('Using bundled IDL (fallback)');
          return bundledIdl;
        }
      } catch {
        // Parse failed for this IDL, try next
      }
    }
    verbose('No bundled IDLs matched the required methods');
  }

  // All sources exhausted
  if (metaStorageError) {
    if (metaStorageError instanceof CliError) throw metaStorageError;
    throw new CliError(
      `Failed to fetch IDL from meta-storage: ${metaStorageError.message}`,
      'META_STORAGE_ERROR',
    );
  }

  throw new CliError(
    'No IDL source available. Try: vara-wallet discover <programId> --idl ./program.idl\n' +
    'The IDL file (.idl) comes from the program\'s source repo.\n' +
    'Or set meta-storage: vara-wallet config set metaStorageUrl https://meta-storage.vara.network',
    'IDL_NOT_FOUND',
  );
}

/**
 * Parse a local IDL v1 file without requiring an API connection or programId.
 * Useful for encoding constructor payloads before deployment.
 */
export async function parseIdlFileV1(idlPath: string): Promise<Sails> {
  const parser = await getV1Parser();
  const sails = new Sails(parser);
  const idlString = await readIdlFile(idlPath);
  try {
    sails.parseIdl(idlString);
  } catch (err) {
    throw new CliError(
      `Failed to parse IDL: ${err instanceof Error ? err.message : String(err)}`,
      'IDL_PARSE_ERROR',
    );
  }
  return sails;
}

/** Parse a local IDL v2 file. */
export async function parseIdlFileV2(idlPath: string): Promise<SailsProgram> {
  const parser = await getV2Parser();
  const idlString = await readIdlFile(idlPath);
  try {
    const doc = parser.parse(idlString);
    return new SailsProgram(doc);
  } catch (err) {
    throw new CliError(
      `Failed to parse IDL: ${err instanceof Error ? err.message : String(err)}`,
      'IDL_PARSE_ERROR',
    );
  }
}

/**
 * Parse a local IDL file, auto-detecting version.
 * Used by offline flows (ctor encoding, encode/decode commands).
 */
export async function parseIdlFileAuto(idlPath: string): Promise<LoadedSails> {
  const idlString = await readIdlFile(idlPath);
  const version = detectIdlVersion(idlString);

  if (version === 'v2') {
    const parser = await getV2Parser();
    try {
      return new SailsProgram(parser.parse(idlString));
    } catch (err) {
      throw new CliError(
        `Failed to parse IDL: ${err instanceof Error ? err.message : String(err)}`,
        'IDL_PARSE_ERROR',
      );
    }
  }

  // 'unknown' — try v1 first, fall back to v2.
  try {
    const parser = await getV1Parser();
    const sails = new Sails(parser);
    sails.parseIdl(idlString);
    return sails;
  } catch (v1Err) {
    try {
      const parser = await getV2Parser();
      return new SailsProgram(parser.parse(idlString));
    } catch (v2Err) {
      const v1Msg = v1Err instanceof Error ? v1Err.message : String(v1Err);
      const v2Msg = v2Err instanceof Error ? v2Err.message : String(v2Err);
      throw new CliError(
        `IDL parse failed on both v1 and v2 parsers.\n  v1: ${v1Msg}\n  v2: ${v2Msg}`,
        'IDL_PARSE_ERROR',
      );
    }
  }
}

/** @deprecated Alias for parseIdlFileV1. */
export const parseIdlFile = parseIdlFileV1;

async function readIdlFile(idlPath: string): Promise<string> {
  try {
    return await fs.promises.readFile(idlPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CliError(`IDL file not found: ${idlPath}`, 'IDL_FILE_NOT_FOUND');
    }
    throw new CliError(`Failed to read IDL file: ${idlPath}`, 'IDL_FILE_ERROR');
  }
}

/** Runtime check: is this a v2 SailsProgram instance? */
export function isSailsV2(sails: LoadedSails): sails is SailsProgram {
  return sails instanceof SailsProgram;
}

/**
 * Return the IDL version of a loaded Sails instance.
 */
export function getSailsVersion(sails: LoadedSails): 'v1' | 'v2' {
  return isSailsV2(sails) ? 'v2' : 'v1';
}

/**
 * Get the type-name → user-defined-type map for a loaded Sails instance.
 *
 * - v1: reads `sails._program.types` (existing hex-bytes.ts pattern).
 * - v2: merges both `_doc.program.types` (ambient, rare) and
 *   `_doc.services[i].types` (per-service, the common case in IDL v2).
 *   Both reach into private fields — stable within the 1.0.0-beta line
 *   and mirrors v1's access pattern.
 *
 * Returns an empty map if the IDL has no user-defined types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRegistryTypes(sails: LoadedSails): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, any>();
  if (isSailsV2(sails)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (sails as any)._doc;
    // Ambient types on the program block (rare).
    const programTypes = doc?.program?.types as Array<{ name: string }> | undefined;
    if (programTypes) for (const t of programTypes) map.set(t.name, t);
    // Per-service types (where IDL v2 most commonly declares them).
    const services = doc?.services as Array<{ types?: Array<{ name: string }> }> | undefined;
    if (services) {
      for (const svc of services) {
        if (svc.types) for (const t of svc.types) map.set(t.name, t);
      }
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const types = (sails as any)._program?.types as Array<{ name: string; def: unknown }> | undefined;
    if (types) {
      for (const t of types) map.set(t.name, t.def);
    }
  }
  return map;
}

/**
 * Describe a Sails type definition as a human-readable string.
 *
 * v1 walks the TypeDef accessor shape (isPrimitive/asVec/asStruct/…).
 * v2 delegates to SailsProgram.typeResolver.getTypeDeclString which already
 * produces a canonical string representation (e.g. "Option<Vec<u8>>").
 */
export function describeType(sails: LoadedSails, typeDef: unknown): string {
  if (isSailsV2(sails)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return sails.typeResolver.getTypeDeclString(typeDef as any);
    } catch {
      return 'unknown';
    }
  }
  return describeTypeV1(typeDef);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeTypeV1(typeDef: any): string {
  if (typeDef.isPrimitive) {
    const p = typeDef.asPrimitive;
    if (p.isBool) return 'bool';
    if (p.isStr) return 'str';
    if (p.isU8) return 'u8';
    if (p.isU16) return 'u16';
    if (p.isU32) return 'u32';
    if (p.isU64) return 'u64';
    if (p.isU128) return 'u128';
    if (p.isI8) return 'i8';
    if (p.isI16) return 'i16';
    if (p.isI32) return 'i32';
    if (p.isI64) return 'i64';
    if (p.isI128) return 'i128';
    if (p.isActorId) return 'ActorId';
    if (p.isCodeId) return 'CodeId';
    if (p.isMessageId) return 'MessageId';
    if (p.isH256) return 'H256';
    if (p.isU256) return 'U256';
    if (p.isNull) return 'null';
    return 'primitive';
  }
  if (typeDef.isOptional) return `Option<${describeTypeV1(typeDef.asOptional.def)}>`;
  if (typeDef.isVec) return `Vec<${describeTypeV1(typeDef.asVec.def)}>`;
  if (typeDef.isResult) {
    return `Result<${describeTypeV1(typeDef.asResult.ok.def)}, ${describeTypeV1(typeDef.asResult.err.def)}>`;
  }
  if (typeDef.isMap) {
    return `Map<${describeTypeV1(typeDef.asMap.key.def)}, ${describeTypeV1(typeDef.asMap.value.def)}>`;
  }
  if (typeDef.isFixedSizeArray) {
    return `[${describeTypeV1(typeDef.asFixedSizeArray.def)}; ${typeDef.asFixedSizeArray.len}]`;
  }
  if (typeDef.isStruct) {
    const struct = typeDef.asStruct;
    if (struct.isTuple) {
      const fields = struct.fields.map((f: { def: unknown }) => describeTypeV1(f.def));
      return `(${fields.join(', ')})`;
    }
    const fields = struct.fields.map(
      (f: { name: string; def: unknown }) => `${f.name}: ${describeTypeV1(f.def)}`,
    );
    return `{ ${fields.join(', ')} }`;
  }
  if (typeDef.isEnum) {
    const variants = typeDef.asEnum.variants.map(
      (v: { name: string; def: { isPrimitive?: boolean; asPrimitive?: { isNull?: boolean } } }) => {
        if (v.def?.isPrimitive && v.def.asPrimitive?.isNull) return v.name;
        return `${v.name}(${describeTypeV1(v.def)})`;
      },
    );
    return variants.join(' | ');
  }
  if (typeDef.isUserDefined) return typeDef.asUserDefined.name;
  return 'unknown';
}

/** Minimal shape that both v1 Sails.services[X] and v2 SailsProgram.services[X] satisfy. */
interface ServiceLike {
  functions: Record<string, FuncLike>;
  queries: Record<string, FuncLike>;
  events: Record<string, EventLike>;
}
interface FuncLike {
  args: Array<{ name: string; typeDef: unknown }>;
  returnTypeDef: unknown;
  docs?: string;
}
interface EventLike {
  typeDef: unknown;
  /** Pre-rendered type string (v2) or undefined (v1). Preferred when present. */
  type?: unknown;
  docs?: string;
}

/**
 * Build a structured description of all services in a Sails program.
 * Shape is identical across v1 and v2 for consumers like the discover command.
 */
export function describeSailsProgram(sails: LoadedSails): Record<string, unknown> {
  const services: Record<string, unknown> = {};
  const allServices = sails.services as Record<string, ServiceLike>;

  for (const [serviceName, service] of Object.entries(allServices)) {
    const functions: Record<string, unknown> = {};
    const queries: Record<string, unknown> = {};
    const events: Record<string, unknown> = {};

    for (const [funcName, func] of Object.entries(service.functions)) {
      functions[funcName] = {
        args: func.args.map((a) => ({
          name: a.name,
          type: describeType(sails, a.typeDef),
        })),
        returnType: describeType(sails, func.returnTypeDef),
        docs: func.docs || null,
      };
    }

    for (const [queryName, query] of Object.entries(service.queries)) {
      queries[queryName] = {
        args: query.args.map((a) => ({
          name: a.name,
          type: describeType(sails, a.typeDef),
        })),
        returnType: describeType(sails, query.returnTypeDef),
        docs: query.docs || null,
      };
    }

    for (const [eventName, event] of Object.entries(service.events)) {
      // v2 events expose `.type` as a pre-rendered string from the
      // TypeResolver (see sails-idl-v2.ts); prefer it when available.
      // v1 events have no such property — fall back to walking `.typeDef`.
      const typeStr =
        typeof event.type === 'string'
          ? event.type
          : describeType(sails, event.typeDef);
      events[eventName] = {
        type: typeStr,
        docs: event.docs || null,
      };
    }

    services[serviceName] = { functions, queries, events };
  }

  return services;
}
