/**
 * Regression test for Finding C from the /review pass:
 * describeSailsProgram must render v2 events with all three payload
 * shapes — unit variant, single unnamed payload, named-field struct —
 * as useful strings, not "unknown".
 */
import * as path from 'path';
import { parseIdlFileV2, describeSailsProgram } from '../services/sails';

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-events.idl');

interface EventDesc { type: string; docs: string | null }
interface ServiceDesc { events: Record<string, EventDesc> }

describe('describeSailsProgram — v2 event payload rendering', () => {
  it('renders all three event shapes without "unknown"', async () => {
    const program = await parseIdlFileV2(FIXTURE);
    const desc = describeSailsProgram(program) as Record<string, ServiceDesc>;
    const events = desc.Walker.events;

    // Unit variant.
    expect(events.Stopped.type).toBe('Null');

    // Single unnamed payload — pre-rendered by TypeResolver.
    expect(events.StepCount.type).toBe('u32');

    // Named-field event — our custom renderer handles this.
    expect(events.Walked.type).toMatch(/from:\s*\(i32,\s*i32\),\s*to:\s*\(i32,\s*i32\)/);
    expect(events.Walked.type).not.toBe('unknown');

    // Doc strings propagated for all three.
    expect(events.Stopped.docs).toContain('Unit variant');
    expect(events.Walked.docs).toContain('Named-field event');
  });
});
