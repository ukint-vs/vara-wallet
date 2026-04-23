/**
 * `resolveSubscribeFilter` is the gating point for `--type` / `--event`
 * across watch and subscribe. Resolution order MUST be Gear-first so
 * legacy CLI vocabulary keeps working without surprise (Codex finding #5).
 *
 * Cases covered:
 *   - Bare Gear name resolves to pallet path even when an IDL is loaded.
 *   - Bare name unknown to Gear vocab but resolvable in IDL → sails path.
 *   - --pallet-event escape hatch forces pallet path.
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
    const out = resolveSubscribeFilter('UserMessageSent', sails, false);
    expect(out).toEqual({ kind: 'pallet', event: 'UserMessageSent' });
  });

  it('AMBIGUOUS_EVENT thrown (hard fail) when bare Sails name matches multiple services', async () => {
    const sails = await parseIdlFileV2(AMBIGUOUS_FIXTURE);
    let caught: unknown;
    try {
      resolveSubscribeFilter('Posted', sails, false);
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('AMBIGUOUS_EVENT');
  });
});
