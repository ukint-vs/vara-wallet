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
 * Coerce args for a Sails method/constructor call.
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
