/**
 * Verifies `formatUserMessageSentMaybeDecoded` (closes #36 — IDL-aware watch
 * + subscribe). The helper is the seam between raw NDJSON output and Sails-
 * decoded enrichment: it MUST be additive (no existing fields renamed or
 * dropped) and MUST pre-filter by source program (Codex finding #2 —
 * sails-js's events[E].is() does not check source).
 *
 * Output schema invariants:
 *   - When sails == null OR source != programId OR no decode match:
 *     output is exactly `formatUserMessageSent(event)` — no `sails` key.
 *   - When all three pass: append `sails: {service, event, data}`.
 *   - Persisted SQLite event rows store the full JSON object as `data`,
 *     so the additive shape keeps schema migrations unnecessary.
 */
import * as path from 'path';
import { SailsProgram } from 'sails-js';
import { parseIdlFileV2 } from '../services/sails';
import { formatUserMessageSentMaybeDecoded } from '../commands/subscribe/shared';

const EVENTS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-events.idl');

const ZERO = '0x' + '00'.repeat(32);
const PROGRAM_ID = '0x' + '11'.repeat(32);
const OTHER_PROGRAM = '0x' + '22'.repeat(32);

function buildHeader(interfaceIdLike: unknown, entryId: number, routeIdx: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes[0] = 0x47; bytes[1] = 0x4d;
  bytes[2] = 1; bytes[3] = 16;
  const idObj = interfaceIdLike as { bytes: Uint8Array };
  bytes.set(idObj.bytes, 4);
  bytes[12] = entryId & 0xff;
  bytes[13] = (entryId >> 8) & 0xff;
  bytes[14] = routeIdx & 0xff;
  bytes[15] = 0;
  return bytes;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out;
}
function toHex(bytes: Uint8Array): string {
  let out = '0x'; for (const b of bytes) out += b.toString(16).padStart(2, '0'); return out;
}

function buildUms(payload: Uint8Array, sourceHex: string): unknown {
  return {
    data: {
      message: {
        id: { toHex: () => '0x' + 'ee'.repeat(32) },
        payload: Object.assign(payload, { toHex: () => toHex(payload), toU8a: () => payload }),
        source: { toHex: () => sourceHex, eq: (other: unknown) => sourceHex === String(other) },
        destination: {
          toHex: () => ZERO,
          eq: (other: unknown) => String(other) === ZERO || (other as { toHex?: () => string })?.toHex?.() === ZERO,
        },
        value: { toString: () => '0' },
        details: { isSome: false },
      },
    },
  };
}

function buildStepCountUms(sails: SailsProgram, value: number, sourceHex: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (sails as any)._doc;
  const svc = doc.services.find((s: { name: string }) => s.name === 'Walker');
  const evIdx = svc.events.findIndex((e: { name: string }) => e.name === 'StepCount');
  const entryId = svc.events[evIdx].entry_id ?? evIdx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routeIdx = (sails.services as any).Walker.routeIdx as number;
  const header = buildHeader(svc.interface_id, entryId, routeIdx);
  return buildUms(concat(header, new Uint8Array([value, 0, 0, 0])), sourceHex);
}

describe('formatUserMessageSentMaybeDecoded', () => {
  let sails: SailsProgram;
  beforeAll(async () => { sails = await parseIdlFileV2(EVENTS_FIXTURE) as SailsProgram; });

  it('appends sails: block on successful decode (additive, no existing fields touched)', () => {
    const event = buildStepCountUms(sails, 42, PROGRAM_ID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = formatUserMessageSentMaybeDecoded(event as any, sails, PROGRAM_ID);
    // Existing fields preserved.
    expect(out.messageId).toBeDefined();
    expect(out.source).toBe(PROGRAM_ID);
    expect(out.destination).toBe(ZERO);
    expect(out.payload).toMatch(/^0x/);
    expect(out.value).toBe('0');
    expect(out.details).toBeNull();
    // Decoded block appended (0.15 shape: decoded.kind === 'sails').
    expect(out.decoded).toEqual({ kind: 'sails', service: 'Walker', event: 'StepCount', data: 42 });
    // Old top-level sails: field is gone (renamed for forward-compat).
    expect(out.sails).toBeUndefined();
  });

  it('omits decoded block when no IDL is loaded (raw passthrough)', () => {
    const event = buildStepCountUms(sails, 42, PROGRAM_ID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = formatUserMessageSentMaybeDecoded(event as any, null, PROGRAM_ID);
    expect(out.decoded).toBeUndefined();
    expect(out.sails).toBeUndefined();
    expect(out.payload).toMatch(/^0x/);
  });

  it('omits decoded block when source !== programId (pre-filter — events[E].is() only checks destination + payload prefix)', () => {
    // Same valid Sails payload, but the message's source is OTHER_PROGRAM.
    // sails-js's events[E].is() would still return true (it only checks
    // destination + payload prefix), so we must skip decode at the
    // formatter layer to avoid spuriously labeling cross-program events.
    const event = buildStepCountUms(sails, 42, OTHER_PROGRAM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = formatUserMessageSentMaybeDecoded(event as any, sails, PROGRAM_ID);
    expect(out.decoded).toBeUndefined();
    expect(out.sails).toBeUndefined();
    expect(out.source).toBe(OTHER_PROGRAM);
  });
});
