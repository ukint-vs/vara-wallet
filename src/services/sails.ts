import { GearApi } from '@gear-js/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import * as fs from 'fs';
import { CliError, verbose, addressToHex } from '../utils';
import { readConfig } from './config';
import { BUNDLED_VFT_IDLS } from '../idl/bundled-idls';

let parserPromise: Promise<SailsIdlParser> | null = null;

async function getParser(): Promise<SailsIdlParser> {
  if (!parserPromise) {
    parserPromise = SailsIdlParser.new();
  }
  return parserPromise;
}

export interface SailsSetupOptions {
  idl?: string;
  programId: string;
  /** Optional validator for bundled IDL fallback. When provided, bundled IDLs
   *  are tried as a last resort; the validator must return true for the IDL to be accepted.
   *  Callers typically check that the required method exists in some service. */
  idlValidator?: (sails: Sails) => boolean;
  /** Optional bundled IDL strings to try as fallback. When provided, these are used
   *  instead of the default VFT bundled IDLs. Requires idlValidator to be set. */
  bundledIdls?: string[];
}

/**
 * Load and parse a Sails IDL, returning a configured Sails instance.
 *
 * IDL resolution:
 * 1. --idl <path> flag (local file)
 * 2. Remote fetch from meta-storage using program's codeId
 * 3. Bundled IDL fallback (only when idlValidator is provided)
 */
export async function loadSails(
  api: GearApi,
  options: SailsSetupOptions,
): Promise<Sails> {
  const parser = await getParser();
  const sails = new Sails(parser);

  const programId = addressToHex(options.programId);
  const idlString = await resolveIdl(api, { ...options, programId }, parser);
  sails.parseIdl(idlString);
  sails.setApi(api);
  sails.setProgramId(programId);

  return sails;
}

async function resolveIdl(
  api: GearApi,
  options: SailsSetupOptions,
  parser: SailsIdlParser,
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

  // 3. Bundled IDL fallback (only when a validator is provided)
  if (options.idlValidator) {
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
 * Parse a local IDL file without requiring an API connection or programId.
 * Useful for encoding constructor payloads before deployment.
 */
export async function parseIdlFile(idlPath: string): Promise<Sails> {
  const parser = await getParser();
  const sails = new Sails(parser);
  let idlString: string;
  try {
    idlString = await fs.promises.readFile(idlPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CliError(`IDL file not found: ${idlPath}`, 'IDL_FILE_NOT_FOUND');
    }
    throw new CliError(`Failed to read IDL file: ${idlPath}`, 'IDL_FILE_ERROR');
  }
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

/**
 * Describe a Sails type definition as a human-readable string.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeType(typeDef: any): string {
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
  if (typeDef.isOptional) return `Option<${describeType(typeDef.asOptional.def)}>`;
  if (typeDef.isVec) return `Vec<${describeType(typeDef.asVec.def)}>`;
  if (typeDef.isResult) {
    return `Result<${describeType(typeDef.asResult.ok.def)}, ${describeType(typeDef.asResult.err.def)}>`;
  }
  if (typeDef.isMap) {
    return `Map<${describeType(typeDef.asMap.key.def)}, ${describeType(typeDef.asMap.value.def)}>`;
  }
  if (typeDef.isFixedSizeArray) {
    return `[${describeType(typeDef.asFixedSizeArray.def)}; ${typeDef.asFixedSizeArray.len}]`;
  }
  if (typeDef.isStruct) {
    const struct = typeDef.asStruct;
    if (struct.isTuple) {
      const fields = struct.fields.map((f: { def: unknown }) => describeType(f.def));
      return `(${fields.join(', ')})`;
    }
    const fields = struct.fields.map(
      (f: { name: string; def: unknown }) => `${f.name}: ${describeType(f.def)}`,
    );
    return `{ ${fields.join(', ')} }`;
  }
  if (typeDef.isEnum) {
    const variants = typeDef.asEnum.variants.map(
      (v: { name: string; def: { isPrimitive?: boolean; asPrimitive?: { isNull?: boolean } } }) => {
        if (v.def?.isPrimitive && v.def.asPrimitive?.isNull) return v.name;
        return `${v.name}(${describeType(v.def)})`;
      },
    );
    return variants.join(' | ');
  }
  if (typeDef.isUserDefined) return typeDef.asUserDefined.name;
  return 'unknown';
}

/**
 * Build a structured description of all services in a Sails program.
 */
export function describeSailsProgram(sails: Sails): Record<string, unknown> {
  const services: Record<string, unknown> = {};

  for (const [serviceName, service] of Object.entries(sails.services)) {
    const functions: Record<string, unknown> = {};
    const queries: Record<string, unknown> = {};
    const events: Record<string, unknown> = {};

    for (const [funcName, func] of Object.entries(service.functions)) {
      functions[funcName] = {
        args: func.args.map((a: { name: string; typeDef: unknown }) => ({
          name: a.name,
          type: describeType(a.typeDef),
        })),
        returnType: describeType(func.returnTypeDef),
        docs: func.docs || null,
      };
    }

    for (const [queryName, query] of Object.entries(service.queries)) {
      queries[queryName] = {
        args: query.args.map((a: { name: string; typeDef: unknown }) => ({
          name: a.name,
          type: describeType(a.typeDef),
        })),
        returnType: describeType(query.returnTypeDef),
        docs: query.docs || null,
      };
    }

    for (const [eventName, event] of Object.entries(service.events)) {
      events[eventName] = {
        type: describeType(event.typeDef),
        docs: event.docs || null,
      };
    }

    services[serviceName] = { functions, queries, events };
  }

  return services;
}
