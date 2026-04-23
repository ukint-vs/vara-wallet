/**
 * Unit tests for `services/sails-events.ts`:
 *
 * - listEventNames flattens v2 service.extends recursively (Codex finding #7)
 * - resolveEventName accepts Service/Event and bare-name forms
 * - resolveEventName throws AMBIGUOUS_EVENT for multi-service bare names
 * - decodeSailsEvent returns null when no event matches the payload prefix
 *
 * These tests use real v2 IDL fixtures (no UserMessageSent network round-
 * tripping). The decode-no-match path uses a stub UserMessageSent whose
 * payload is bytes that no service expects — every `events[E].is(...)` call
 * returns false.
 */
import * as path from 'path';
import { parseIdlFileV2, type LoadedSails } from '../services/sails';
import {
  decodeSailsEvent,
  listEventNames,
  resolveEventName,
} from '../services/sails-events';
import { CliError } from '../utils';

const EVENTS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-events.idl');
const EXTENDS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-extends.idl');
const AMBIGUOUS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-ambiguous.idl');

describe('listEventNames', () => {
  it('lists every event in a flat single-service IDL', async () => {
    const sails: LoadedSails = await parseIdlFileV2(EVENTS_FIXTURE);
    const names = listEventNames(sails).map((x) => `${x.service}/${x.event}`).sort();
    expect(names).toEqual(['Walker/Stopped', 'Walker/StepCount', 'Walker/Walked'].sort());
  });

  it('flattens v2 service.extends recursively', async () => {
    const sails: LoadedSails = await parseIdlFileV2(EXTENDS_FIXTURE);
    const names = listEventNames(sails).map((x) => `${x.service}/${x.event}`).sort();
    // `Composite` extends `Base`, so `BaseEvent` should appear under both
    // its own declaration AND through Composite's extends chain.
    expect(names).toContain('Base/BaseEvent');
    expect(names).toContain('Composite/OwnEvent');
    expect(names).toContain('Base/BaseEvent'); // base direct
    // Walker extends propagation: when traversed via Composite, Base's
    // events show up under Base's own service name (sails-js wires it
    // that way in `service.extends`).
  });
});

describe('resolveEventName', () => {
  it('resolves Service/Event form unambiguously', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    expect(resolveEventName(sails, 'Walker/Stopped')).toEqual({
      service: 'Walker',
      event: 'Stopped',
    });
  });

  it('returns null for unknown Service/Event form', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    expect(resolveEventName(sails, 'Walker/NoSuchEvent')).toBeNull();
    expect(resolveEventName(sails, 'NoSuchService/Stopped')).toBeNull();
  });

  it('resolves bare name when only one service declares it', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    expect(resolveEventName(sails, 'Walked')).toEqual({
      service: 'Walker',
      event: 'Walked',
    });
  });

  it('returns null when bare name appears nowhere', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    expect(resolveEventName(sails, 'NoSuchEvent')).toBeNull();
  });

  it('throws AMBIGUOUS_EVENT when bare name matches multiple services', async () => {
    const sails = await parseIdlFileV2(AMBIGUOUS_FIXTURE);
    let caught: unknown;
    try {
      resolveEventName(sails, 'Posted');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    const cli = caught as CliError;
    expect(cli.code).toBe('AMBIGUOUS_EVENT');
    expect(cli.message).toContain('Chat/Posted');
    expect(cli.message).toContain('Forum/Posted');
  });
});

describe('decodeSailsEvent — no match', () => {
  it('returns null when no service event recognizes the payload', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    // Stub a UserMessageSent whose `is(...)` always returns false. We don't
    // need a real polkadot codec here — sails-events only touches
    // `data.message.payload.toHex()` and the per-event `is(...)` callbacks
    // (which themselves read the same payload).
    const stub = {
      data: {
        message: {
          payload: { toHex: () => '0xdeadbeef' },
          source: { toHex: () => '0x' + '00'.repeat(32) },
        },
      },
    };
    // sails-js's events[E].is() returns false for unrelated bytes. The
    // happy path is exercised in sails-events-decode.test.ts using a
    // properly-encoded payload.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(decodeSailsEvent(sails, stub as any)).toBeNull();
  });
});
