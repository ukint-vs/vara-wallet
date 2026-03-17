import { GearApi } from '@gear-js/api';
import { Sails } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import * as fs from 'fs';
import { CliError, verbose, addressToHex } from '../utils';
import { readConfig } from './config';

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
}

/**
 * Load and parse a Sails IDL, returning a configured Sails instance.
 *
 * IDL resolution:
 * 1. --idl <path> flag (local file)
 * 2. Remote fetch from meta-storage using program's codeId
 */
export async function loadSails(
  api: GearApi,
  options: SailsSetupOptions,
): Promise<Sails> {
  const parser = await getParser();
  const sails = new Sails(parser);

  const programId = addressToHex(options.programId);
  const idlString = await resolveIdl(api, { ...options, programId });
  sails.parseIdl(idlString);
  sails.setApi(api);
  sails.setProgramId(programId);

  return sails;
}

async function resolveIdl(api: GearApi, options: SailsSetupOptions): Promise<string> {
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
  verbose(`Fetching IDL from meta-storage for program ${options.programId}`);

  const config = readConfig();
  const metaStorageUrl = process.env.VARA_META_STORAGE || config.metaStorageUrl;

  if (!metaStorageUrl) {
    throw new CliError(
      'No IDL source available. Use --idl <path> or set VARA_META_STORAGE / config metaStorageUrl.',
      'IDL_NOT_FOUND',
    );
  }

  // Get the program's codeId to look up IDL
  const codeId = await api.program.codeId(options.programId);
  verbose(`Program codeId: ${codeId}`);

  const url = `${metaStorageUrl}/sails?codeId=${codeId}`;
  verbose(`Fetching IDL from ${url}`);

  try {
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
        `No IDL found for codeId ${codeId} in meta-storage`,
        'IDL_NOT_FOUND',
      );
    }
    return idl;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `Failed to fetch IDL from meta-storage: ${err instanceof Error ? err.message : err}`,
      'META_STORAGE_ERROR',
    );
  }
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
