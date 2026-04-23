/**
 * IDL-aware Sails event decoding.
 *
 * Wraps the per-service `events[E].is(...)` / `events[E].decode(...)` surface
 * exposed by both v1 `Sails` and v2 `SailsProgram`. The shapes are identical
 * across versions; the only v2-specific wrinkle is `service.extends`, which
 * pulls in events from inherited services and must be walked recursively.
 *
 * Critical invariant the caller MUST honor: sails-js's `events[E].is()` only
 * checks `destination === ZERO_ADDRESS` and the payload prefix — it does NOT
 * check `message.source`. So before calling `decodeSailsEvent`, the caller
 * MUST pre-filter so that `message.source.toHex() === programIdHex`. Skipping
 * that check leaks events from other programs that happen to share the same
 * service hash + event id.
 *
 * The decoded payload runs through `decodeEventData` (alias of the shared
 * decode walker in `decode-sails-result.ts`) so that nested `Option<U256>`,
 * `Vec<U256>`, etc. normalize identically to `call` replies — a single
 * source of truth for "decoded JSON shape", per Codex findings #6 + Phase 1
 * issue #32.
 */
import type { GearApi, UserMessageSent, HexString } from '@gear-js/api';
import type { SailsService } from 'sails-js';
import { CliError, errorMessage, verbose } from '../utils';
import { decodeEventData } from '../utils/decode-sails-result';
import { isSailsV2, type LoadedSails } from './sails';

export interface DecodedSailsEvent {
  service: string;
  event: string;
  data: unknown;
}

/**
 * Try to decode a `UserMessageSent` against every event declared in every
 * service of the loaded IDL (including inherited services from `extends`).
 * Returns the first matching decoded event, or `null` when nothing matches.
 *
 * Caller MUST have pre-filtered so `userMessageSent.data.message.source`
 * equals the program ID this `sails` instance was bound to.
 */
export function decodeSailsEvent(
  sails: LoadedSails,
  userMessageSent: UserMessageSent,
): DecodedSailsEvent | null {
  for (const [serviceName, service] of allServicesIncludingExtends(sails)) {
    for (const [eventName, ev] of Object.entries(service.events)) {
      let matches = false;
      try {
        matches = ev.is(userMessageSent);
      } catch (err) {
        verbose(`decodeSailsEvent: ${serviceName}/${eventName}.is() threw — ${errorMessage(err)}`);
        continue;
      }
      if (!matches) continue;
      let raw: unknown;
      try {
        const payloadHex = userMessageSent.data.message.payload.toHex();
        raw = ev.decode(payloadHex);
      } catch (err) {
        verbose(`decodeSailsEvent: ${serviceName}/${eventName}.decode() threw — ${errorMessage(err)}`);
        return { service: serviceName, event: eventName, data: null };
      }
      const data = decodeEventData(sails, ev.typeDef, raw, serviceName);
      return { service: serviceName, event: eventName, data };
    }
  }
  return null;
}

/**
 * Flat list of every `(service, event)` declared in the IDL, including
 * events propagated from `service.extends`. Used by `resolveEventName`
 * and by user-facing "did-you-mean" lists.
 */
export function listEventNames(sails: LoadedSails): Array<{ service: string; event: string }> {
  const out: Array<{ service: string; event: string }> = [];
  for (const [serviceName, service] of allServicesIncludingExtends(sails)) {
    for (const eventName of Object.keys(service.events)) {
      out.push({ service: serviceName, event: eventName });
    }
  }
  return out;
}

/**
 * Resolve an event name to its `{service, event}` pair.
 *
 * Accepts:
 *   - `"Service/Event"` — always unambiguous; null when either side missing.
 *   - `"Event"` (bare) — succeeds when exactly one service declares it.
 *
 * Throws `CliError('AMBIGUOUS_EVENT')` when a bare name matches multiple
 * services. The error message lists every alternative so the user can
 * disambiguate. Returns `null` when the name appears nowhere — callers
 * decide whether absence is fatal.
 */
export function resolveEventName(
  sails: LoadedSails,
  name: string,
): { service: string; event: string } | null {
  const all = listEventNames(sails);
  if (name.includes('/')) {
    const [svc, ev] = name.split('/', 2);
    const match = all.find((x) => x.service === svc && x.event === ev);
    return match ?? null;
  }
  const matches = all.filter((x) => x.event === name);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const alternatives = matches.map((x) => `${x.service}/${x.event}`).join(', ');
  throw new CliError(
    `Ambiguous event "${name}" — matches ${alternatives}. Use full Service/Event form.`,
    'AMBIGUOUS_EVENT',
  );
}

/**
 * Phase-correlated block-event scan (Codex finding #1 — high severity).
 *
 * Reads `system.events()` at `blockHash`, filters down to records whose
 * `phase.asApplyExtrinsic` matches the index of OUR extrinsic in the
 * block, then keeps only `gear.UserMessageSent` events emitted by our
 * `programIdHex`. Each surviving event runs through `decodeSailsEvent`.
 *
 * The phase scoping prevents the cross-extrinsic event bleed that a naive
 * whole-block walk would cause when other transactions in the same block
 * also emit `UserMessageSent`. The source filter is defense-in-depth: it
 * shouldn't fire after phase scoping but costs nothing and protects
 * against future edge cases (proxy patterns, batched extrinsics, etc.).
 */
export async function collectDecodedEvents(
  api: GearApi,
  sails: LoadedSails,
  blockHash: HexString,
  txHash: HexString,
  programIdHex: HexString,
): Promise<DecodedSailsEvent[]> {
  let extrinsicIdx = -1;
  try {
    const block = await api.rpc.chain.getBlock(blockHash);
    const exts = block.block.extrinsics;
    extrinsicIdx = exts.findIndex((x) => x.hash.toHex() === txHash);
  } catch (err) {
    verbose(`collectDecodedEvents: getBlock failed — ${errorMessage(err)}`);
    return [];
  }
  if (extrinsicIdx < 0) {
    verbose(`collectDecodedEvents: txHash ${txHash} not found in block ${blockHash}`);
    return [];
  }

  let records: ReadonlyArray<unknown>;
  try {
    const apiAt = await api.at(blockHash);
    records = await apiAt.query.system.events() as unknown as ReadonlyArray<unknown>;
  } catch (err) {
    verbose(`collectDecodedEvents: system.events() failed — ${errorMessage(err)}`);
    return [];
  }

  const out: DecodedSailsEvent[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isUserMessageSent = (api.events.gear.UserMessageSent as any).is.bind(api.events.gear.UserMessageSent);
  for (const recordRaw of records) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = recordRaw as any;
    const phase = record?.phase;
    if (!phase?.isApplyExtrinsic) continue;
    if (!phase.asApplyExtrinsic.eq(extrinsicIdx)) continue;
    if (!isUserMessageSent(record.event)) continue;
    const ums = record.event as UserMessageSent;
    if (ums.data.message.source.toHex() !== programIdHex) continue;
    const decoded = decodeSailsEvent(sails, ums);
    if (decoded) out.push(decoded);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────

/**
 * Yield `[serviceName, service]` pairs for every service in the IDL,
 * recursively flattening v2 `service.extends`. v1 has no `extends`, so
 * the v1 path returns the top-level `sails.services` map untouched.
 *
 * The same physical service can appear under multiple names if it is
 * inherited by two different services; that is correct — the caller
 * usually only needs to find one match (decode) or list every reachable
 * event name (filter resolution). De-duping by event identity would
 * require reading internal sails-js state and isn't worth the coupling.
 */
function* allServicesIncludingExtends(
  sails: LoadedSails,
): Generator<[string, ServiceLike]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const services = sails.services as Record<string, any>;
  if (!isSailsV2(sails)) {
    for (const [name, svc] of Object.entries(services)) {
      yield [name, svc as ServiceLike];
    }
    return;
  }
  // v2 — walk extends recursively. Visited set keys on the service
  // instance identity to short-circuit diamond inheritance shapes.
  const visited = new WeakSet<object>();
  const walk = function* (
    name: string,
    svc: SailsService,
  ): Generator<[string, ServiceLike]> {
    if (visited.has(svc)) return;
    visited.add(svc);
    yield [name, svc as unknown as ServiceLike];
    const extended = (svc as unknown as { extends?: Record<string, SailsService> }).extends;
    if (!extended) return;
    for (const [extName, extSvc] of Object.entries(extended)) {
      yield* walk(extName, extSvc);
    }
  };
  for (const [name, svc] of Object.entries(services)) {
    yield* walk(name, svc as SailsService);
  }
}

interface ServiceLike {
  events: Record<string, EventLike>;
}
interface EventLike {
  typeDef: unknown;
  is: (event: UserMessageSent) => boolean;
  decode: (payload: HexString) => unknown;
}
