import { SailsProgram, type Sails } from 'sails-js';
import { CliError } from './errors';

const HEX_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Check if a typeDef represents `vec u8`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isVecU8(typeDef: any): boolean {
  return (
    typeDef.isVec &&
    typeDef.asVec.def.isPrimitive &&
    typeDef.asVec.def.asPrimitive.isU8
  );
}

/**
 * Check if a typeDef represents `[u8; N]`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isFixedU8Array(typeDef: any): { match: boolean; len?: number } {
  if (
    typeDef.isFixedSizeArray &&
    typeDef.asFixedSizeArray.def.isPrimitive &&
    typeDef.asFixedSizeArray.def.asPrimitive.isU8
  ) {
    return { match: true, len: typeDef.asFixedSizeArray.len };
  }
  return { match: false };
}

/**
 * Convert a hex string to a byte array, with validation.
 */
function hexToBytes(value: string, fieldHint?: string): number[] {
  const hex = value.slice(2); // strip 0x
  if (hex.length % 2 !== 0) {
    throw new CliError(
      `Odd-length hex string for byte field${fieldHint ? ` "${fieldHint}"` : ''}: "${value}"`,
      'INVALID_HEX_BYTES',
    );
  }
  if (!HEX_RE.test(value)) {
    throw new CliError(
      `Invalid hex characters in byte field${fieldHint ? ` "${fieldHint}"` : ''}: "${value}"`,
      'INVALID_HEX_BYTES',
    );
  }
  return Array.from(Buffer.from(hex, 'hex'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TypeMap = Map<string, any>;

/**
 * Recursively walk a value alongside its IDL type definition,
 * converting hex strings to byte arrays for `vec u8` and `[u8; N]` fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function coerceHexToBytes(value: unknown, typeDef: any, typeMap: TypeMap, fieldHint?: string): unknown {
  if (value === null || value === undefined) return value;

  // Resolve UserDefined types to their actual definitions
  if (typeDef.isUserDefined) {
    const resolved = typeMap.get(typeDef.asUserDefined.name);
    if (!resolved) return value; // Unknown type, pass through
    return coerceHexToBytes(value, resolved, typeMap, fieldHint);
  }

  // vec u8: convert hex string to byte array
  if (isVecU8(typeDef)) {
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) {
      return hexToBytes(value, fieldHint);
    }
    return value;
  }

  // [u8; N]: convert hex string to byte array, validate length
  const fixed = isFixedU8Array(typeDef);
  if (fixed.match) {
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) {
      const bytes = hexToBytes(value, fieldHint);
      if (bytes.length !== fixed.len) {
        throw new CliError(
          `Hex string decodes to ${bytes.length} bytes but [u8; ${fixed.len}] expects ${fixed.len} bytes${fieldHint ? ` for "${fieldHint}"` : ''}`,
          'INVALID_HEX_BYTES',
        );
      }
      return bytes;
    }
    return value;
  }

  // Struct: recurse into each field
  if (typeDef.isStruct && typeof value === 'object' && !Array.isArray(value)) {
    const struct = typeDef.asStruct;
    if (struct.isTuple && Array.isArray(value)) {
      // Tuple struct: recurse by index
      return struct.fields.map((f: { def: unknown }, i: number) =>
        coerceHexToBytes((value as unknown[])[i], f.def, typeMap, fieldHint),
      );
    }
    const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const field of struct.fields) {
      if (field.name in result) {
        result[field.name] = coerceHexToBytes(result[field.name], field.def, typeMap, field.name);
      }
    }
    return result;
  }

  // Enum: match variant and recurse into payload
  if (typeDef.isEnum && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const variant of typeDef.asEnum.variants) {
      if (variant.name in obj) {
        const variantDef = variant.def;
        if (variantDef?.isPrimitive && variantDef.asPrimitive?.isNull) {
          return value; // Unit variant, no payload
        }
        return { [variant.name]: coerceHexToBytes(obj[variant.name], variantDef, typeMap, variant.name) };
      }
    }
    return value;
  }

  // Optional: recurse into inner type
  if (typeDef.isOptional) {
    return coerceHexToBytes(value, typeDef.asOptional.def, typeMap, fieldHint);
  }

  // Result: recurse into ok/err
  if (typeDef.isResult && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('ok' in obj) {
      return { ok: coerceHexToBytes(obj.ok, typeDef.asResult.ok.def, typeMap, 'ok') };
    }
    if ('err' in obj) {
      return { err: coerceHexToBytes(obj.err, typeDef.asResult.err.def, typeMap, 'err') };
    }
    return value;
  }

  // Vec (non-u8): recurse into elements
  if (typeDef.isVec && Array.isArray(value)) {
    return value.map((item, i) => coerceHexToBytes(item, typeDef.asVec.def, typeMap, fieldHint));
  }

  // Map: recurse into values
  if (typeDef.isMap && typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = coerceHexToBytes(v, typeDef.asMap.value.def, typeMap, k);
    }
    return result;
  }

  return value;
}

/**
 * Coerce args for a Sails v1 method/constructor call.
 * Walks the IDL type tree alongside the args, converting hex strings to byte arrays
 * for `vec u8` and `[u8; N]` typed fields.
 *
 * Falls back to returning args unchanged if type information is unavailable.
 */
export function coerceArgs(
  args: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  argDefs: Array<{ name: string; typeDef: any }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sails: any,
): unknown[] {
  if (args.length === 0) return args;

  // Build type map from sails internal program types
  let typeMap: TypeMap;
  try {
    typeMap = new Map();
    const types = sails._program?.types;
    if (!types) return args; // No type info available, pass through
    for (const t of types) {
      typeMap.set(t.name, t.def);
    }
  } catch {
    return args; // Graceful fallback
  }

  return args.map((arg, i) => {
    if (i >= argDefs.length) return arg;
    return coerceHexToBytes(arg, argDefs[i].typeDef, typeMap, argDefs[i].name);
  });
}

// ────────────────────────────────────────────────────────────────────────
// IDL v2 walker — parallel implementation over the new TypeDecl shape.
//
// v2 TypeDecl is a discriminated union:
//   - PrimitiveType (string literal: 'u8' | 'String' | 'ActorId' | …)
//   - { kind: 'slice',  item: TypeDecl }
//   - { kind: 'array',  item: TypeDecl, len: number }
//   - { kind: 'tuple',  types: TypeDecl[] }
//   - { kind: 'named',  name: string, generics?: TypeDecl[] }
//
// User-defined types (from program.types) are separate `Type` entries:
//   - { kind: 'struct', name, fields: [{name?, type}] }
//   - { kind: 'enum',   name, variants: [{name, fields: [{name?, type}]}] }
//   - { kind: 'alias',  name, target: TypeDecl }
// ────────────────────────────────────────────────────────────────────────

type V2TypeDecl =
  | string
  | { kind: 'slice'; item: V2TypeDecl }
  | { kind: 'array'; item: V2TypeDecl; len: number }
  | { kind: 'tuple'; types: V2TypeDecl[] }
  | { kind: 'named'; name: string; generics?: V2TypeDecl[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V2Type = any; // struct | enum | alias — loose to avoid deep type churn

type V2TypeMap = Map<string, V2Type>;

function isV2PrimitiveU8(typeDecl: V2TypeDecl): boolean {
  return typeof typeDecl === 'string' && typeDecl === 'u8';
}

function isV2SliceU8(typeDecl: V2TypeDecl): boolean {
  return typeof typeDecl === 'object' && typeDecl.kind === 'slice' && isV2PrimitiveU8(typeDecl.item);
}

function isV2ArrayU8(typeDecl: V2TypeDecl): { match: boolean; len?: number } {
  if (typeof typeDecl === 'object' && typeDecl.kind === 'array' && isV2PrimitiveU8(typeDecl.item)) {
    return { match: true, len: typeDecl.len };
  }
  return { match: false };
}

/**
 * v2 equivalent of coerceHexToBytes.
 * Walks a TypeDecl (v2 IDL shape) and converts hex strings to byte arrays
 * for `vec u8` (slice<u8>, Vec<u8>) and `[u8; N]` fields.
 */
export function coerceHexToBytesV2(
  value: unknown,
  typeDecl: V2TypeDecl,
  typeMap: V2TypeMap,
  fieldHint?: string,
): unknown {
  if (value === null || value === undefined) return value;

  // Slice of u8 → bytes
  if (isV2SliceU8(typeDecl)) {
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) {
      return hexToBytes(value, fieldHint);
    }
    return value;
  }

  // Fixed array of u8 → bytes with length validation
  const fixed = isV2ArrayU8(typeDecl);
  if (fixed.match && fixed.len !== undefined) {
    if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) {
      const bytes = hexToBytes(value, fieldHint);
      if (bytes.length !== fixed.len) {
        throw new CliError(
          `Hex string decodes to ${bytes.length} bytes but [u8; ${fixed.len}] expects ${fixed.len} bytes${fieldHint ? ` for "${fieldHint}"` : ''}`,
          'INVALID_HEX_BYTES',
        );
      }
      return bytes;
    }
    return value;
  }

  // PrimitiveType (string literal): no byte fields to coerce
  if (typeof typeDecl === 'string') return value;

  // Slice (non-u8): recurse elements
  if (typeDecl.kind === 'slice') {
    if (Array.isArray(value)) {
      return value.map((item) => coerceHexToBytesV2(item, typeDecl.item, typeMap, fieldHint));
    }
    return value;
  }

  // Array (non-u8): recurse elements
  if (typeDecl.kind === 'array') {
    if (Array.isArray(value)) {
      return value.map((item) => coerceHexToBytesV2(item, typeDecl.item, typeMap, fieldHint));
    }
    return value;
  }

  // Tuple: recurse by index
  if (typeDecl.kind === 'tuple') {
    if (Array.isArray(value)) {
      return typeDecl.types.map((t, i) => coerceHexToBytesV2((value as unknown[])[i], t, typeMap, fieldHint));
    }
    return value;
  }

  // Named type: well-known generics or user-defined
  if (typeDecl.kind === 'named') {
    const { name, generics } = typeDecl;

    // Well-known wrappers
    if (name === 'Option' && generics && generics.length === 1) {
      return coerceHexToBytesV2(value, generics[0], typeMap, fieldHint);
    }
    if (name === 'Result' && generics && generics.length === 2 && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if ('ok' in obj) return { ok: coerceHexToBytesV2(obj.ok, generics[0], typeMap, 'ok') };
      if ('err' in obj) return { err: coerceHexToBytesV2(obj.err, generics[1], typeMap, 'err') };
      return value;
    }
    if (name === 'Vec' && generics && generics.length === 1) {
      // Vec<u8> → bytes via hex coercion
      if (isV2PrimitiveU8(generics[0])) {
        if (typeof value === 'string' && value.startsWith('0x') && value.length > 2) {
          return hexToBytes(value, fieldHint);
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((item) => coerceHexToBytesV2(item, generics[0], typeMap, fieldHint));
      }
      return value;
    }
    if ((name === 'Map' || name === 'BTreeMap' || name === 'HashMap') && generics && generics.length === 2 && typeof value === 'object' && !Array.isArray(value)) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = coerceHexToBytesV2(v, generics[1], typeMap, k);
      }
      return result;
    }

    // User-defined type: look up in type map and recurse
    const userType = typeMap.get(name);
    if (!userType) return value; // Unknown type, pass through

    // Alias: recurse into target
    if (userType.kind === 'alias' && userType.target) {
      return coerceHexToBytesV2(value, userType.target, typeMap, fieldHint);
    }

    // Struct: recurse into fields
    if (userType.kind === 'struct' && userType.fields && typeof value === 'object' && !Array.isArray(value)) {
      const fields = userType.fields as Array<{ name?: string; type: V2TypeDecl }>;
      const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const field of fields) {
        if (field.name && field.name in result) {
          result[field.name] = coerceHexToBytesV2(result[field.name], field.type, typeMap, field.name);
        }
      }
      return result;
    }

    // Struct (tuple-shaped — all fields unnamed): recurse by index
    if (userType.kind === 'struct' && userType.fields && Array.isArray(value)) {
      const fields = userType.fields as Array<{ name?: string; type: V2TypeDecl }>;
      return fields.map((f, i) => coerceHexToBytesV2((value as unknown[])[i], f.type, typeMap, f.name));
    }

    // Enum: match variant and recurse into payload fields
    if (userType.kind === 'enum' && userType.variants && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const variants = userType.variants as Array<{ name: string; fields: Array<{ name?: string; type: V2TypeDecl }> }>;
      for (const variant of variants) {
        if (variant.name in obj) {
          if (!variant.fields || variant.fields.length === 0) {
            return value; // unit variant
          }
          const payload = obj[variant.name];
          if (variant.fields.length === 1 && !variant.fields[0].name) {
            // Single unnamed field: payload is the raw value
            return { [variant.name]: coerceHexToBytesV2(payload, variant.fields[0].type, typeMap, variant.name) };
          }
          // Struct-shaped variant payload
          if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
            const result: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
            for (const f of variant.fields) {
              if (f.name && f.name in result) {
                result[f.name] = coerceHexToBytesV2(result[f.name], f.type, typeMap, f.name);
              }
            }
            return { [variant.name]: result };
          }
          // Tuple-shaped variant payload (array)
          if (Array.isArray(payload)) {
            return { [variant.name]: variant.fields.map((f, i) => coerceHexToBytesV2((payload as unknown[])[i], f.type, typeMap, f.name)) };
          }
          return value;
        }
      }
      return value;
    }

    return value;
  }

  return value;
}

/**
 * Coerce args for a Sails v2 method/constructor call.
 *
 * Merges user-defined types from both possible declaration sites in the
 * parsed IDL document (private `_doc` field, stable within the
 * 1.0.0-beta line — mirrors v1's `_program.types` access pattern):
 *   - `_doc.program.types` — program-level / ambient types (rare).
 *   - `_doc.services[i].types` — per-service types, which is where v2
 *     IDLs normally declare struct / enum / alias shapes.
 */
export function coerceArgsV2(
  args: unknown[],
  argDefs: Array<{ name: string; typeDef: V2TypeDecl }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
): unknown[] {
  if (args.length === 0) return args;

  let typeMap: V2TypeMap;
  try {
    typeMap = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (program as any)._doc;
    // Ambient types on the program block.
    const programTypes = doc?.program?.types as Array<{ name: string }> | undefined;
    if (programTypes) for (const t of programTypes) typeMap.set(t.name, t);
    // Per-service types (v2 usually declares types inside a service block).
    const services = doc?.services as Array<{ types?: Array<{ name: string }> }> | undefined;
    if (services) {
      for (const svc of services) {
        if (svc.types) for (const t of svc.types) typeMap.set(t.name, t);
      }
    }
  } catch {
    return args; // Graceful fallback
  }

  return args.map((arg, i) => {
    if (i >= argDefs.length) return arg;
    return coerceHexToBytesV2(arg, argDefs[i].typeDef, typeMap, argDefs[i].name);
  });
}

/**
 * Dispatch coerceArgs to the v1 or v2 walker based on the Sails instance type.
 * This is what generic commands (call, encode, program) should call.
 */
export function coerceArgsAuto(
  args: unknown[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  argDefs: Array<{ name: string; typeDef: any }>,
  sails: Sails | SailsProgram,
): unknown[] {
  if (sails instanceof SailsProgram) {
    return coerceArgsV2(args, argDefs as Array<{ name: string; typeDef: V2TypeDecl }>, sails);
  }
  return coerceArgs(args, argDefs, sails);
}
