/**
 * Phase-correlated block-event scan (closes #37, addresses Codex finding #1).
 *
 * `collectDecodedEvents` walks `system.events()` at the inclusion block,
 * filters by:
 *   1. Phase index matching OUR extrinsic (rejects cross-extrinsic bleed).
 *   2. `api.events.gear.UserMessageSent.is(...)` (rejects other gear events).
 *   3. `message.source === programIdHex` (rejects events from other programs).
 *   4. `decodeSailsEvent` returning a match (rejects raw / unrelated messages).
 *
 * Each test injects a curated record set into a stub `api` and asserts which
 * records survive the filter chain.
 */
import * as path from 'path';
import { SailsProgram } from 'sails-js';
import { parseIdlFileV2 } from '../services/sails';
import { collectDecodedEvents } from '../services/sails-events';

const EVENTS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-events.idl');

const ZERO = '0x' + '00'.repeat(32);
const PROGRAM_ID = '0x' + '11'.repeat(32);
const OTHER_PROGRAM = '0x' + '22'.repeat(32);
const TX_HASH = '0x' + 'aa'.repeat(32);
const OTHER_TX = '0x' + 'bb'.repeat(32);
const BLOCK_HASH = '0x' + 'cc'.repeat(32);

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
        payload: Object.assign(payload, { toHex: () => toHex(payload), toU8a: () => payload }),
        source: { toHex: () => sourceHex, eq: (other: unknown) => sourceHex === String(other) },
        destination: { eq: (other: unknown) => String(other) === ZERO || (other as { toHex?: () => string })?.toHex?.() === ZERO },
      },
    },
  };
}

function buildPhase(extrinsicIdx: number): unknown {
  return {
    isApplyExtrinsic: true,
    asApplyExtrinsic: { eq: (n: number) => n === extrinsicIdx },
  };
}

interface StubRecord {
  phase: unknown;
  event: unknown;
}

function buildApi(records: StubRecord[], extrinsicHashes: string[]): unknown {
  const isUserMessageSent = (event: unknown) =>
    !!(event as { __isUserMessageSent?: boolean })?.__isUserMessageSent;
  return {
    rpc: {
      chain: {
        getBlock: async () => ({
          block: {
            extrinsics: extrinsicHashes.map((h) => ({ hash: { toHex: () => h } })),
          },
        }),
      },
    },
    at: async () => ({
      query: {
        system: {
          events: async () => records,
        },
      },
    }),
    events: {
      gear: {
        UserMessageSent: {
          is: isUserMessageSent,
        },
      },
    },
  };
}

async function buildSails(): Promise<SailsProgram> {
  return await parseIdlFileV2(EVENTS_FIXTURE) as SailsProgram;
}

interface ServiceWire {
  interface_id?: unknown;
  events?: Array<{ name: string; entry_id?: number }>;
}

function getServiceWire(sails: SailsProgram, name: string): ServiceWire {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = (sails as any)._doc;
  return doc.services.find((s: { name: string }) => s.name === name);
}

function getRouteIdx(sails: SailsProgram, name: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sails.services as any)[name].routeIdx as number;
}

function buildStepCountUms(sails: SailsProgram, value: number, sourceHex: string): { __isUserMessageSent: true; data: unknown } {
  const svc = getServiceWire(sails, 'Walker');
  const evIdx = svc.events!.findIndex((e) => e.name === 'StepCount');
  const entryId = svc.events![evIdx].entry_id ?? evIdx;
  const header = buildHeader(svc.interface_id, entryId, getRouteIdx(sails, 'Walker'));
  const payload = new Uint8Array([value, 0, 0, 0]);
  const ums = buildUms(concat(header, payload), sourceHex);
  return Object.assign({ __isUserMessageSent: true as const }, ums as { data: unknown });
}

describe('collectDecodedEvents — phase-correlated event scan', () => {
  let sails: SailsProgram;
  beforeAll(async () => { sails = await buildSails(); });

  it('returns [] when no records match (no UserMessageSent in block)', async () => {
    const api = buildApi(
      [{ phase: buildPhase(0), event: { __isUserMessageSent: false } }],
      [TX_HASH],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await collectDecodedEvents(api as any, sails, BLOCK_HASH as `0x${string}`, TX_HASH as `0x${string}`, PROGRAM_ID as `0x${string}`);
    expect(out).toEqual([]);
  });

  it('decodes a single in-phase UserMessageSent from our program', async () => {
    const ums = buildStepCountUms(sails, 42, PROGRAM_ID);
    const api = buildApi(
      [{ phase: buildPhase(0), event: ums }],
      [TX_HASH],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await collectDecodedEvents(api as any, sails, BLOCK_HASH as `0x${string}`, TX_HASH as `0x${string}`, PROGRAM_ID as `0x${string}`);
    expect(out).toEqual([{ service: 'Walker', event: 'StepCount', data: 42 }]);
  });

  it('excludes UserMessageSent from a DIFFERENT extrinsic (Codex finding #1 — phase scoping)', async () => {
    // Our tx is at index 0. Plant a UserMessageSent at extrinsic 1
    // (different phase) — it must NOT be returned even though it's a
    // valid Sails event from the same program.
    const ours = buildStepCountUms(sails, 42, PROGRAM_ID);
    const otherTxUms = buildStepCountUms(sails, 99, PROGRAM_ID);
    const api = buildApi(
      [
        { phase: buildPhase(1), event: otherTxUms }, // wrong phase — excluded
        { phase: buildPhase(0), event: ours },        // in-phase — included
      ],
      [TX_HASH, OTHER_TX],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await collectDecodedEvents(api as any, sails, BLOCK_HASH as `0x${string}`, TX_HASH as `0x${string}`, PROGRAM_ID as `0x${string}`);
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe(42);
  });

  it('excludes UserMessageSent from a different program (source filter is defense-in-depth)', async () => {
    const ours = buildStepCountUms(sails, 42, PROGRAM_ID);
    const otherProg = buildStepCountUms(sails, 7, OTHER_PROGRAM);
    const api = buildApi(
      [
        { phase: buildPhase(0), event: otherProg }, // same phase, different source — excluded
        { phase: buildPhase(0), event: ours },
      ],
      [TX_HASH],
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await collectDecodedEvents(api as any, sails, BLOCK_HASH as `0x${string}`, TX_HASH as `0x${string}`, PROGRAM_ID as `0x${string}`);
    expect(out).toHaveLength(1);
    expect(out[0].data).toBe(42);
  });
});
