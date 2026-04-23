/**
 * Post-process a sails-js query/function reply into a fully-decoded JSON tree.
 *
 * Motivation: sails-js decodes the top-level codec with toBigInt/toString for a
 * handful of primitives and with .toJSON() for everything else. Polkadot's
 * .toJSON() recurses through Vecs/structs/tuples/Option but emits a hex string
 * for any codec wider than JSON numbers can hold (U256, u128, u64 in some
 * configurations). The result: top-level U256 gets a decimal string, but the
 * same U256 nested inside Option / Vec / struct stays as raw hex. Agents
 * wrapping the CLI have to re-parse those hex blobs, which is the bug
 * reported in issue #32.
 *
 * Fix: walk the declared return type (ISailsTypeDef) against the already-
 * decoded JS value and rewrite numeric leaves (hex string OR bigint) to a
 * decimal string. The walker is type-driven, not value-driven, so we never
 * confuse an ActorId hex with a numeric hex.
 *
 * V1 typeDef shape (from sails-js-types 0.5.1 accessor interface):
 *   { isPrimitive, asPrimitive, isOptional, asOptional, isVec, asVec,
 *     isStruct, asStruct, isEnum, asEnum, isResult, asResult, isMap, asMap,
 *     isFixedSizeArray, asFixedSizeArray, isUserDefined, asUserDefined }
 *
 * V2 typeDef shape (verified against sails-js 1.0.0-beta.1 parser output):
 *   Node = string | { kind, ... }
 *   - bare string      → primitive name, e.g. "u32", "String", "u256"
 *   - {kind:"named"}   → { name, generics?: Node[] } — Option / Result / user-defined
 *   - {kind:"tuple"}   → { types: Node[] }
 *   - {kind:"slice"}   → { item: Node }            — `vec T`
 *   - {kind:"array"}   → { item: Node, len: number } — `[T; N]`
 *   User-defined types (_doc.services[i].types):
 *     { name, kind:"struct", fields: [{name, type}] }
 *     { name, kind:"enum",   variants: [{name, fields: [{name?, type}]}] }
 */

import { LoadedSails, isSailsV2, getRegistryTypes, describeType } from '../services/sails';
import { verbose } from './output';

type V2Node = string | { kind: string; [k: string]: unknown };

export function decodeSailsResult(
  sails: LoadedSails,
  typeDef: unknown,
  value: unknown,
  serviceName: string,
): unknown {
  try {
    return walk(sails, typeDef, value, serviceName);
  } catch (err) {
    verbose(`decodeSailsResult: walker threw — returning raw value. ${err instanceof Error ? err.message : String(err)}`);
    return value;
  }
}

function walk(sails: LoadedSails, typeDef: unknown, value: unknown, serviceName: string): unknown {
  if (typeDef == null) return value;
  if (isSailsV2(sails)) return walkV2(sails, typeDef as V2Node, value, serviceName);
  return walkV1(sails, typeDef, value, serviceName);
}

// ────────────────────────────────────────────────────────────────────────
// V1 walker — accessor form (isPrimitive / asPrimitive / ...)
// ────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V1TypeDef = any;

function walkV1(sails: LoadedSails, td: V1TypeDef, value: unknown, serviceName: string): unknown {
  if (td.isPrimitive) return decodePrimitive(primitiveV1Name(td.asPrimitive), value);

  if (td.isOptional) return decodeOption(value, (inner) => walkV1(sails, td.asOptional.def, inner, serviceName));

  if (td.isVec) {
    if (!Array.isArray(value)) return fallback(sails, td, value, 'expected Vec<T> value to be an array');
    return value.map((v) => walkV1(sails, td.asVec.def, v, serviceName));
  }

  if (td.isFixedSizeArray) {
    const inner = td.asFixedSizeArray.def;
    if (isByteType(primitiveName(inner, false))) return value;
    if (!Array.isArray(value)) return fallback(sails, td, value, 'expected fixed-size array value to be an array');
    return value.map((v) => walkV1(sails, inner, v, serviceName));
  }

  if (td.isStruct) {
    const struct = td.asStruct;
    if (struct.isTuple) {
      if (!Array.isArray(value)) return fallback(sails, td, value, 'expected tuple value to be an array');
      return struct.fields.map((f: { def: V1TypeDef }, i: number) => walkV1(sails, f.def, value[i], serviceName));
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return fallback(sails, td, value, 'expected struct value to be an object');
    }
    return decodeStructFields(
      struct.fields as Array<{ name: string; def: V1TypeDef }>,
      value as Record<string, unknown>,
      (fdef, fvalue) => walkV1(sails, fdef, fvalue, serviceName),
    );
  }

  if (td.isEnum) {
    return decodeEnum(
      td.asEnum.variants as Array<{ name: string; def: V1TypeDef }>,
      value,
      (vdef, vvalue) => walkV1(sails, vdef, vvalue, serviceName),
      (vdef) => v1VariantIsUnit(vdef),
    );
  }

  if (td.isResult) {
    return decodeResult(
      value,
      (ok) => walkV1(sails, td.asResult.ok.def, ok, serviceName),
      (err) => walkV1(sails, td.asResult.err.def, err, serviceName),
    );
  }

  if (td.isMap) {
    if (!Array.isArray(value)) return fallback(sails, td, value, 'expected Map value to be an array of pairs');
    return value.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) return pair;
      return [
        walkV1(sails, td.asMap.key.def, pair[0], serviceName),
        walkV1(sails, td.asMap.value.def, pair[1], serviceName),
      ];
    });
  }

  if (td.isUserDefined) {
    const resolved = getRegistryTypes(sails, serviceName).get(td.asUserDefined.name);
    if (!resolved) return fallback(sails, td, value, `user-defined type "${td.asUserDefined.name}" not in registry`);
    return walkV1(sails, resolved, value, serviceName);
  }

  return fallback(sails, td, value, 'unrecognized v1 typeDef');
}

function primitiveV1Name(asPrim: V1TypeDef): string {
  if (asPrim.isNull) return 'null';
  if (asPrim.isBool) return 'bool';
  if (asPrim.isChar) return 'char';
  if (asPrim.isStr) return 'str';
  if (asPrim.isU8) return 'u8';
  if (asPrim.isU16) return 'u16';
  if (asPrim.isU32) return 'u32';
  if (asPrim.isU64) return 'u64';
  if (asPrim.isU128) return 'u128';
  if (asPrim.isU256) return 'u256';
  if (asPrim.isI8) return 'i8';
  if (asPrim.isI16) return 'i16';
  if (asPrim.isI32) return 'i32';
  if (asPrim.isI64) return 'i64';
  if (asPrim.isI128) return 'i128';
  if (asPrim.isActorId) return 'actorid';
  if (asPrim.isCodeId) return 'codeid';
  if (asPrim.isMessageId) return 'messageid';
  if (asPrim.isH256) return 'h256';
  if (asPrim.isH160) return 'h160';
  if (asPrim.isNonZeroU8) return 'u8';
  if (asPrim.isNonZeroU16) return 'u16';
  if (asPrim.isNonZeroU32) return 'u32';
  if (asPrim.isNonZeroU64) return 'u64';
  if (asPrim.isNonZeroU128) return 'u128';
  if (asPrim.isNonZeroU256) return 'u256';
  return 'unknown';
}

function v1VariantIsUnit(def: V1TypeDef): boolean {
  return !!def && def.isPrimitive && def.asPrimitive?.isNull;
}

// ────────────────────────────────────────────────────────────────────────
// V2 walker — object form (kind-discriminated)
// ────────────────────────────────────────────────────────────────────────

function walkV2(sails: LoadedSails, node: V2Node, value: unknown, serviceName: string): unknown {
  if (typeof node === 'string') return decodePrimitive(normalizePrimV2(node), value);

  switch (node.kind) {
    case 'slice': {
      if (!Array.isArray(value)) return fallback(sails, node, value, 'expected slice value to be an array');
      const inner = node.item as V2Node;
      return value.map((v) => walkV2(sails, inner, v, serviceName));
    }

    case 'array': {
      const inner = node.item as V2Node;
      if (typeof inner === 'string' && isByteType(normalizePrimV2(inner))) return value;
      if (!Array.isArray(value)) return fallback(sails, node, value, 'expected array value to be an array');
      return value.map((v) => walkV2(sails, inner, v, serviceName));
    }

    case 'tuple': {
      const items = (node.types as V2Node[]) ?? [];
      if (!Array.isArray(value)) return fallback(sails, node, value, 'expected tuple value to be an array');
      return items.map((t, i) => walkV2(sails, t, value[i], serviceName));
    }

    case 'named': {
      const name = node.name as string;
      const generics = (node.generics as V2Node[] | undefined) ?? [];
      if (name === 'Option' && generics.length === 1) {
        return decodeOption(value, (inner) => walkV2(sails, generics[0], inner, serviceName));
      }
      if (name === 'Result' && generics.length === 2) {
        return decodeResult(
          value,
          (ok) => walkV2(sails, generics[0], ok, serviceName),
          (err) => walkV2(sails, generics[1], err, serviceName),
        );
      }
      // User-defined type — resolve from registry, then recurse on its body.
      const resolved = getRegistryTypes(sails, serviceName).get(name) as
        | { kind?: string; fields?: Array<{ name?: string; type: V2Node }>; variants?: Array<{ name: string; fields?: Array<{ name?: string; type: V2Node }> }> }
        | undefined;
      if (!resolved) return fallback(sails, node, value, `user-defined type "${name}" not in registry`);
      return walkV2UserType(sails, resolved, value, serviceName);
    }

    default:
      return fallback(sails, node, value, `unrecognized v2 node kind "${node.kind}"`);
  }
}

function walkV2UserType(
  sails: LoadedSails,
  udt: { kind?: string; fields?: Array<{ name?: string; type: V2Node }>; variants?: Array<{ name: string; fields?: Array<{ name?: string; type: V2Node }> }> },
  value: unknown,
  serviceName: string,
): unknown {
  if (udt.kind === 'struct') {
    const fields = udt.fields ?? [];
    const isTuple = fields.length > 0 && fields.every((f) => !f.name);
    if (isTuple) {
      if (!Array.isArray(value)) return fallback(sails, udt, value, 'expected tuple-struct value to be an array');
      return fields.map((f, i) => walkV2(sails, f.type, value[i], serviceName));
    }
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return fallback(sails, udt, value, 'expected struct value to be an object');
    }
    return decodeStructFields(
      fields.map((f) => ({ name: f.name as string, def: f.type as unknown })),
      value as Record<string, unknown>,
      (fdef, fvalue) => walkV2(sails, fdef as V2Node, fvalue, serviceName),
    );
  }

  if (udt.kind === 'enum') {
    const variants = udt.variants ?? [];
    return decodeEnum(
      variants.map((v) => ({ name: v.name, def: v })),
      value,
      (variant, payload) => walkV2EnumPayload(sails, variant as typeof variants[number], payload, serviceName),
      (variant) => !((variant as typeof variants[number]).fields?.length),
    );
  }

  return fallback(sails, udt, value, `unrecognized user-defined kind "${udt.kind}"`);
}

function walkV2EnumPayload(
  sails: LoadedSails,
  variant: { fields?: Array<{ name?: string; type: V2Node }> },
  payload: unknown,
  serviceName: string,
): unknown {
  const fields = variant.fields ?? [];
  if (fields.length === 0) return undefined; // unit
  if (fields.length === 1 && !fields[0].name) {
    // Single unnamed payload — emit decoded value directly (not wrapped).
    return walkV2(sails, fields[0].type, payload, serviceName);
  }
  const allNamed = fields.every((f) => !!f.name);
  if (allNamed) {
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
      return fallback(sails, variant, payload, 'expected struct-shaped enum payload to be an object');
    }
    return decodeStructFields(
      fields.map((f) => ({ name: f.name as string, def: f.type as unknown })),
      payload as Record<string, unknown>,
      (fdef, fvalue) => walkV2(sails, fdef as V2Node, fvalue, serviceName),
    );
  }
  // Mixed — tuple-like.
  if (!Array.isArray(payload)) return fallback(sails, variant, payload, 'expected tuple-shaped enum payload to be an array');
  return fields.map((f, i) => walkV2(sails, f.type, payload[i], serviceName));
}

function normalizePrimV2(s: string): string {
  const lower = s.toLowerCase();
  if (lower === 'string' || lower === 'str') return 'str';
  if (lower === 'actorid') return 'actorid';
  if (lower === 'codeid') return 'codeid';
  if (lower === 'messageid') return 'messageid';
  if (lower === 'h256') return 'h256';
  if (lower === 'h160') return 'h160';
  if (lower === 'bool') return 'bool';
  if (lower === 'char') return 'char';
  if (lower === 'null' || lower === '()') return 'null';
  // ints — u8..u256, i8..i128, nonzero-*
  const m = lower.match(/^(?:nonzero)?(u|i)(\d+)$/);
  if (m) return `${m[1]}${m[2]}`;
  return lower;
}

// ────────────────────────────────────────────────────────────────────────
// Shared decode primitives (value-level, type-agnostic)
// ────────────────────────────────────────────────────────────────────────

function decodePrimitive(name: string, value: unknown): unknown {
  if (name === 'null') return null;
  if (isByteType(name)) return value; // ActorId, H256, etc. — keep hex
  if (isBigIntType(name)) return hexOrBigIntToDecimal(value);
  // bool, str, char, u8..u32, i8..i32 — JSON-native passthrough.
  return value;
}

function isByteType(name: string): boolean {
  return name === 'actorid' || name === 'codeid' || name === 'messageid' || name === 'h256' || name === 'h160';
}

function isBigIntType(name: string): boolean {
  return name === 'u64' || name === 'u128' || name === 'u256' || name === 'i64' || name === 'i128';
}

function hexOrBigIntToDecimal(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return value; // fits — pass through
  if (typeof value === 'string') {
    if (/^-?0x[0-9a-fA-F]+$/.test(value) || /^-?\d+$/.test(value)) {
      try {
        return BigInt(value).toString();
      } catch {
        return value;
      }
    }
  }
  return value;
}

function decodeOption(value: unknown, decodeInner: (v: unknown) => unknown): unknown {
  if (value == null) return null;
  // Belt-and-suspenders: unwrap {Some: x} / {None: null} if polkadot ever emits
  // the non-flattened shape (it usually doesn't).
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const k = keys[0].toLowerCase();
      if (k === 'none') return null;
      if (k === 'some') return decodeInner(obj[keys[0]]);
    }
  }
  return decodeInner(value);
}

function decodeResult(
  value: unknown,
  decodeOk: (v: unknown) => unknown,
  decodeErr: (v: unknown) => unknown,
): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const k = keys[0].toLowerCase();
      if (k === 'ok') return { kind: 'Ok', value: decodeOk(obj[keys[0]]) };
      if (k === 'err') return { kind: 'Err', value: decodeErr(obj[keys[0]]) };
    }
  }
  return value;
}

function decodeStructFields(
  fields: Array<{ name: string; def: unknown }>,
  value: Record<string, unknown>,
  decodeField: (def: unknown, v: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const jsonKey = findKeyCaseInsensitiveFirst(value, f.name);
    out[f.name] = decodeField(f.def, jsonKey === undefined ? undefined : value[jsonKey]);
  }
  return out;
}

function decodeEnum(
  variants: Array<{ name: string; def: unknown }>,
  value: unknown,
  decodeVariant: (variantDef: unknown, payload: unknown) => unknown,
  isUnit: (variantDef: unknown) => boolean,
): unknown {
  // Unit variant emitted as a bare string.
  if (typeof value === 'string') {
    const match = variants.find((v) => v.name.toLowerCase() === value.toLowerCase());
    if (match) return { kind: match.name };
    return value;
  }
  // Payload variant emitted as {variantName: payload}.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) {
      const jsonKey = keys[0];
      const match = variants.find((v) => v.name.toLowerCase() === jsonKey.toLowerCase()
        || lowerFirst(v.name) === jsonKey);
      if (match) {
        const payload = (value as Record<string, unknown>)[jsonKey];
        if (isUnit(match.def)) return { kind: match.name };
        const decoded = decodeVariant(match.def, payload);
        return decoded === undefined ? { kind: match.name } : { kind: match.name, value: decoded };
      }
    }
  }
  return value;
}

function findKeyCaseInsensitiveFirst(obj: Record<string, unknown>, declared: string): string | undefined {
  if (declared in obj) return declared;
  const lf = lowerFirst(declared);
  if (lf in obj) return lf;
  const lowerDecl = declared.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lowerDecl) return k;
  }
  return undefined;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0].toLowerCase() + s.slice(1);
}

function primitiveName(typeDef: unknown, _v2: boolean): string {
  // Reused by v1 array check. Safe on v2 too because v2 bare strings pass straight through.
  if (typeof typeDef === 'string') return normalizePrimV2(typeDef);
  const td = typeDef as V1TypeDef;
  if (td && td.isPrimitive) return primitiveV1Name(td.asPrimitive);
  return 'unknown';
}

function fallback(sails: LoadedSails, typeDef: unknown, value: unknown, reason: string): unknown {
  try {
    verbose(`decodeSailsResult fallback: ${reason}. typeDef=${describeType(sails, typeDef)}`);
  } catch {
    verbose(`decodeSailsResult fallback: ${reason}`);
  }
  return value;
}
