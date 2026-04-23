import * as path from 'path';
import { Sails, SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js-parser';
import { parseIdlFileV2, type LoadedSails } from '../services/sails';
import { decodeSailsResult } from '../utils/decode-sails-result';
import { BUNDLED_VFT_IDLS } from '../idl/bundled-idls';

const V2_FIXTURE = path.join(__dirname, 'fixtures', 'sample-v2-numeric.idl');

/**
 * We pin one VFT bundled IDL that has the exact shapes the issue reports:
 * `opt u256` (BalanceOf), `vec struct { struct {...}, struct {...} }` (Allowances).
 * The parser caches internally so repeated parse in tests is cheap.
 */
async function loadV1Vft(): Promise<Sails> {
  const parser = await SailsIdlParser.new();
  const sails = new Sails(parser);
  // Pick the first bundled IDL that exposes VftExtension.BalanceOf with `opt u256`.
  for (const idl of BUNDLED_VFT_IDLS) {
    if (!idl.includes('VftExtension')) continue;
    try {
      sails.parseIdl(idl);
      if (sails.services.VftExtension?.queries?.BalanceOf) return sails;
    } catch {
      continue;
    }
  }
  throw new Error('Could not find a bundled VFT IDL with VftExtension.BalanceOf');
}

async function loadV2Nums(): Promise<SailsProgram> {
  return parseIdlFileV2(V2_FIXTURE) as Promise<SailsProgram>;
}

function returnTypeDef(sails: LoadedSails, service: string, query: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sails.services as any)[service].queries[query].returnTypeDef;
}

// ──────────────────────────────────────────────────────────────────────────
// V1 PATH — drives off the real bundled VFT IDL
// ──────────────────────────────────────────────────────────────────────────

describe('decodeSailsResult (v1 — VFT)', () => {
  let sails: Sails;
  beforeAll(async () => { sails = await loadV1Vft(); });

  describe('primitives (regression lock)', () => {
    it('passes top-level str through unchanged', () => {
      const td = returnTypeDef(sails, 'VftMetadata', 'Symbol');
      expect(decodeSailsResult(sails, td, 'WBTC', 'VftMetadata')).toBe('WBTC');
    });

    it('top-level u256 (bigint input) → decimal string', () => {
      const td = returnTypeDef(sails, 'VftExtension', 'MinimumBalance');
      expect(decodeSailsResult(sails, td, 344243812414584118439n, 'VftExtension'))
        .toBe('344243812414584118439');
    });

    it('top-level u256 (hex input) → decimal string', () => {
      const td = returnTypeDef(sails, 'VftExtension', 'MinimumBalance');
      // 0x..0b21371a = 186726170 (BigInt of the hex literal)
      expect(decodeSailsResult(sails, td, '0x000000000000000000000000000000000000000000000000000000000b21371a', 'VftExtension'))
        .toBe('186726170');
    });

    it('top-level u32 (number input) → number out', () => {
      const td = returnTypeDef(sails, 'VftExtension', 'ExpiryPeriod');
      expect(decodeSailsResult(sails, td, 1234, 'VftExtension')).toBe(1234);
    });

    it('top-level bool passthrough', () => {
      const td = returnTypeDef(sails, 'VftAdmin', 'IsPaused');
      expect(decodeSailsResult(sails, td, true, 'VftAdmin')).toBe(true);
      expect(decodeSailsResult(sails, td, false, 'VftAdmin')).toBe(false);
    });

    it('ActorId stays hex (no SS58 reshape in MVP)', () => {
      const td = returnTypeDef(sails, 'VftAdmin', 'Admin');
      const hex = '0xd4358e6eb3f3b6a3f2b0a8e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6';
      expect(decodeSailsResult(sails, td, hex, 'VftAdmin')).toBe(hex);
    });
  });

  describe('Option<u256> (BalanceOf) — the primary bug', () => {
    const td = (s: Sails) => returnTypeDef(s, 'VftExtension', 'BalanceOf');

    it('None → null', () => {
      expect(decodeSailsResult(sails, td(sails), null, 'VftExtension')).toBeNull();
    });

    it('Some hex → decimal string', () => {
      expect(decodeSailsResult(sails, td(sails),
        '0x000000000000000000000000000000000000000000000000000000000b21371a',
        'VftExtension')).toBe('186726170');
    });

    it('Some bigint → decimal string (belt-and-suspenders)', () => {
      expect(decodeSailsResult(sails, td(sails), 186726170n, 'VftExtension')).toBe('186726170');
    });
  });

  describe('Vec<tuple<tuple<ActorId,ActorId>, tuple<u256,u32>>> (Allowances)', () => {
    const td = (s: Sails) => returnTypeDef(s, 'VftExtension', 'Allowances');

    it('decodes every U256 while keeping ActorIds hex', () => {
      const input = [
        [
          ['0xa6c1000000000000000000000000000000000000000000000000000000000001',
           '0x5392000000000000000000000000000000000000000000000000000000000002'],
          ['0x00000000000000000000000000000000000000000000000000038d7ea4c68000', 26832345],
        ],
      ];
      const out = decodeSailsResult(sails, td(sails), input, 'VftExtension');
      expect(out).toEqual([
        [
          ['0xa6c1000000000000000000000000000000000000000000000000000000000001',
           '0x5392000000000000000000000000000000000000000000000000000000000002'],
          ['1000000000000000', 26832345],
        ],
      ]);
    });

    it('empty Vec → empty Vec', () => {
      expect(decodeSailsResult(sails, td(sails), [], 'VftExtension')).toEqual([]);
    });
  });

  describe('Option<tuple<u256,u32>> (AllowanceOf)', () => {
    const td = (s: Sails) => returnTypeDef(s, 'VftExtension', 'AllowanceOf');

    it('None → null', () => {
      expect(decodeSailsResult(sails, td(sails), null, 'VftExtension')).toBeNull();
    });

    it('Some [hex-u256, u32] → [decimal, u32]', () => {
      expect(decodeSailsResult(sails, td(sails),
        ['0x00000000000000000000000000000000000000000000000000038d7ea4c68000', 100],
        'VftExtension'))
        .toEqual(['1000000000000000', 100]);
    });
  });

  describe('defensive fallback', () => {
    it('shape mismatch (Vec expected, string given) returns original value', () => {
      const td = returnTypeDef(sails, 'VftExtension', 'Balances');
      expect(decodeSailsResult(sails, td, 'not-an-array', 'VftExtension')).toBe('not-an-array');
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// V2 PATH — drives off sample-v2-numeric.idl
// ──────────────────────────────────────────────────────────────────────────

describe('decodeSailsResult (v2 — Nums fixture)', () => {
  let sails: SailsProgram;
  beforeAll(async () => { sails = await loadV2Nums(); });

  describe('primitives', () => {
    it('top-level u256 bigint → decimal', () => {
      // Synthesize a bare "U256" typeDef (v2 form) — Balances.slice.item.
      const td = 'U256';
      expect(decodeSailsResult(sails, td, 42n, 'Nums')).toBe('42');
    });

    it('top-level u256 hex → decimal', () => {
      expect(decodeSailsResult(sails, 'U256',
        '0x0000000000000000000000000000000000000000000000000000000000000002a',
        'Nums')).toBe('42');
    });

    it('u64+ number input is always stringified (consistent JSON shape)', () => {
      // Defensive: if any upstream path hands us a small-enough u64 as a
      // JS number, we still emit a string. Prevents the 53-bit precision
      // cliff and keeps agents from having to typeof-branch per field.
      expect(decodeSailsResult(sails, 'u64', 42, 'Nums')).toBe('42');
      expect(decodeSailsResult(sails, 'u128', 100, 'Nums')).toBe('100');
      expect(decodeSailsResult(sails, 'U256', 7, 'Nums')).toBe('7');
    });
  });

  describe('Option<u256>', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Balance');

    it('None → null', () => {
      expect(decodeSailsResult(sails, td(sails), null, 'Nums')).toBeNull();
    });

    it('Some hex → decimal', () => {
      expect(decodeSailsResult(sails, td(sails),
        '0x000000000000000000000000000000000000000000000000000000000b21371a',
        'Nums')).toBe('186726170');
    });
  });

  describe('Vec<u256>', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Balances');
    it('maps every element', () => {
      expect(decodeSailsResult(sails, td(sails), ['0x2a', 100n, 200n], 'Nums'))
        .toEqual(['42', '100', '200']);
    });
  });

  describe('Tuple (u256, u32)', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Pair');
    it('decodes U256 slot, passes u32', () => {
      expect(decodeSailsResult(sails, td(sails), ['0x2a', 1234], 'Nums'))
        .toEqual(['42', 1234]);
    });
  });

  describe('Named struct {value: u256, expires: u32}', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Ledger');
    it('decodes u256 field, keeps u32', () => {
      expect(decodeSailsResult(sails, td(sails),
        { value: '0x2a', expires: 42 }, 'Nums'))
        .toEqual({ value: '42', expires: 42 });
    });

    it('tolerates polkadot-lowercased first-letter keys', () => {
      // Polkadot often lowercases the first char in toJSON: "Value" -> "value".
      // Declared as lowercase already here; also prove case-insensitive match.
      expect(decodeSailsResult(sails, td(sails),
        { value: '0x2a', Expires: 7 }, 'Nums'))
        .toEqual({ value: '42', expires: 7 });
    });
  });

  describe('Enum TokenState', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Status');

    it('unit variant string → {kind}', () => {
      expect(decodeSailsResult(sails, td(sails), 'Idle', 'Nums'))
        .toEqual({ kind: 'Idle' });
    });

    it('single-payload variant → {kind, value} with decoded u256', () => {
      expect(decodeSailsResult(sails, td(sails), { active: '0x2a' }, 'Nums'))
        .toEqual({ kind: 'Active', value: '42' });
    });

    it('struct-shaped variant → decoded fields', () => {
      expect(decodeSailsResult(sails, td(sails),
        { locked: { by: '0x2a', until: 123n } }, 'Nums'))
        .toEqual({ kind: 'Locked', value: { by: '42', until: '123' } });
    });
  });

  describe('Result<u256, String>', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Try');
    it('Ok hex → {kind: Ok, value: decimal}', () => {
      expect(decodeSailsResult(sails, td(sails), { ok: '0x2a' }, 'Nums'))
        .toEqual({ kind: 'Ok', value: '42' });
    });
    it('Err string → passthrough string', () => {
      expect(decodeSailsResult(sails, td(sails), { err: 'boom' }, 'Nums'))
        .toEqual({ kind: 'Err', value: 'boom' });
    });
  });

  describe('Option<Vec<AccountAmount>> (nested user-defined)', () => {
    const td = (s: SailsProgram) => returnTypeDef(s, 'Nums', 'Allowances');

    it('Some list of structs → every u256 decoded', () => {
      const input = [
        { account: '0x01', amount: '0x2a' },
        { account: 100n, amount: 200n },
      ];
      expect(decodeSailsResult(sails, td(sails), input, 'Nums')).toEqual([
        { account: '1', amount: '42' },
        { account: '100', amount: '200' },
      ]);
    });

    it('None → null', () => {
      expect(decodeSailsResult(sails, td(sails), null, 'Nums')).toBeNull();
    });
  });

  describe('defensive fallback', () => {
    it('unknown user-defined name returns original value', () => {
      const td = { kind: 'named', name: 'DoesNotExist' };
      expect(decodeSailsResult(sails, td, { foo: 1 }, 'Nums')).toEqual({ foo: 1 });
    });

    it('shape mismatch (tuple expected, number given) returns original', () => {
      const td = returnTypeDef(sails, 'Nums', 'Pair');
      expect(decodeSailsResult(sails, td, 42, 'Nums')).toBe(42);
    });
  });

  describe('primitive name forward-compat', () => {
    const hex32 = '0xd435' + '0'.repeat(60);

    it('snake_case actor_id normalizes to ActorId passthrough', () => {
      expect(decodeSailsResult(sails, 'actor_id', hex32, 'Nums')).toBe(hex32);
    });

    it('PascalCase ActorId is unchanged', () => {
      expect(decodeSailsResult(sails, 'ActorId', hex32, 'Nums')).toBe(hex32);
    });

    it('snake_case message_id also passes hex through', () => {
      expect(decodeSailsResult(sails, 'message_id', hex32, 'Nums')).toBe(hex32);
    });
  });
});
