/**
 * `resolveSubscribeFilter` is the gating point for the `--event` flag
 * across watch and subscribe messages. Resolution order MUST be:
 *   1. `pallet:` prefix → strip and resolve as pallet event (replaces
 *      the old --pallet-event flag).
 *   2. Bare Gear vocab name → pallet (back-compat).
 *   3. Sails IDL match if loaded.
 *   4. Fallback to pallet validation (clean error).
 *
 * Cases covered:
 *   - Bare Gear name resolves to pallet path even when an IDL is loaded.
 *   - Bare name unknown to Gear vocab but resolvable in IDL → sails path.
 *   - `pallet:Name` prefix forces pallet path even when an IDL is loaded.
 *   - `pallet:` prefix with invalid name → clean validation error.
 *   - Ambiguous bare Sails name → AMBIGUOUS_EVENT (hard fail, not warn).
 */
import * as path from 'path';
import { parseIdlFileV2 } from '../services/sails';
import { resolveSubscribeFilter } from '../commands/subscribe/shared';
import { CliError } from '../utils';

const EVENTS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-events.idl');
const AMBIGUOUS_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-ambiguous.idl');

describe('resolveSubscribeFilter', () => {
  it('Gear-first precedence — bare name in Gear vocab resolves to pallet path even with IDL loaded', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    const out = resolveSubscribeFilter('UserMessageSent', sails);
    expect(out).toEqual({ kind: 'pallet', event: 'UserMessageSent' });
  });

  it('pallet: prefix forces pallet vocab even when an IDL is loaded', async () => {
    const sails = await parseIdlFileV2(EVENTS_FIXTURE);
    const out = resolveSubscribeFilter('pallet:UserMessageSent', sails);
    expect(out).toEqual({ kind: 'pallet', event: 'UserMessageSent' });
  });

  it('pallet: prefix with no IDL loaded works the same as a bare pallet name', () => {
    const out = resolveSubscribeFilter('pallet:MessageQueued', null);
    expect(out).toEqual({ kind: 'pallet', event: 'MessageQueued' });
  });

  it('pallet: prefix with an invalid pallet name surfaces validation error (not silent)', () => {
    let caught: unknown;
    try {
      resolveSubscribeFilter('pallet:NonexistentEvent', null);
    } catch (err) { caught = err; }
    // validateEventName throws CliError with a code; we just assert the throw.
    expect(caught).toBeInstanceOf(CliError);
  });

  it('AMBIGUOUS_EVENT thrown (hard fail) when bare Sails name matches multiple services', async () => {
    const sails = await parseIdlFileV2(AMBIGUOUS_FIXTURE);
    let caught: unknown;
    try {
      resolveSubscribeFilter('Posted', sails);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('AMBIGUOUS_EVENT');
  });

  it('AMBIGUOUS_EVENT bypassed when pallet: prefix is used (forces pallet path, never touches IDL)', async () => {
    const sails = await parseIdlFileV2(AMBIGUOUS_FIXTURE);
    // `Posted` is ambiguous in the Sails IDL but isn't a pallet event, so
    // pallet:Posted should fail at validateEventName, NOT at AMBIGUOUS_EVENT.
    let caught: unknown;
    try {
      resolveSubscribeFilter('pallet:Posted', sails);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).not.toBe('AMBIGUOUS_EVENT');
  });

  it('Service/Event qualified name resolves to sails path (unambiguous)', async () => {
    const sails = await parseIdlFileV2(AMBIGUOUS_FIXTURE);
    const out = resolveSubscribeFilter('Forum/Posted', sails);
    expect(out.kind).toBe('sails');
    if (out.kind === 'sails') {
      expect(out.service).toBe('Forum');
      expect(out.event).toBe('Posted');
    }
  });
});
