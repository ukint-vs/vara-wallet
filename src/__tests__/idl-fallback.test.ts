/**
 * When the `!@sails:` directive is present, the loader tries v2 first
 * but falls back to v1 on parse failure. When the directive is absent,
 * the order flips: v1 first, fall back to v2.
 *
 * Asserted by inspecting the error-message ordering when both parsers
 * reject the input — the parser tried first appears first in the
 * combined message.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseIdlFileAuto } from '../services/sails';

function writeTmp(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idl-fallback-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('parseIdlFileAuto — fallback ordering', () => {
  it('directive present → tries v2 first (v2 appears before v1 in error)', async () => {
    const idl = writeTmp(
      'directive-bad.idl',
      '!@sails: 1.0.0-beta.1\nthis is not valid syntax for either parser\n',
    );
    let err: Error | undefined;
    try { await parseIdlFileAuto(idl); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    const msg = err!.message;
    // Combined error lists both parsers.
    expect(msg).toMatch(/v1:/);
    expect(msg).toMatch(/v2:/);
    // v2 tried first → appears before v1 in the message.
    expect(msg.indexOf('v2:')).toBeLessThan(msg.indexOf('v1:'));
  });

  it('no directive → tries v1 first (v1 appears before v2 in error)', async () => {
    const idl = writeTmp(
      'no-directive-bad.idl',
      'this is not valid syntax for either parser',
    );
    let err: Error | undefined;
    try { await parseIdlFileAuto(idl); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    const msg = err!.message;
    expect(msg).toMatch(/v1:/);
    expect(msg).toMatch(/v2:/);
    expect(msg.indexOf('v1:')).toBeLessThan(msg.indexOf('v2:'));
  });

  it('directive present + valid v2 → v2 wins (no fallback needed)', async () => {
    // Minimal valid v2 IDL — parser tolerates empty services block.
    const idl = writeTmp(
      'min-v2.idl',
      '!@sails: 1.0.0-beta.1\nprogram P { constructors { Default(); } services {} }\n',
    );
    const loaded = await parseIdlFileAuto(idl);
    // Using the public isSailsV2 / getSailsVersion helpers via parseIdlFileAuto
    // is exercised elsewhere; here we just prove it resolves without error.
    expect(loaded).toBeDefined();
  });
});
