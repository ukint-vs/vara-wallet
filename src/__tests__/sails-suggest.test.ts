/**
 * Cross-service "Did you mean?" hints for missing service / method names.
 *
 * Issue #33. Helpers live in src/services/sails.ts:
 *   - suggestMethod(sails, service, method)
 *   - suggestService(sails, service)
 *
 * Two suggestion sources, one capped suggestion:
 *   1. Exact case-insensitive hit in another service (the common
 *      `Vft/Name` → `VftMetadata/Name` case for VFT IDLs).
 *   2. A single Levenshtein-≤2 fuzzy match. Ties at the minimum
 *      distance produce no suggestion (zero-false-positive bar).
 */
import { SailsIdlParser } from 'sails-js-parser';
import { Sails } from 'sails-js';
import { VFT_STANDARD_IDL } from '../idl/bundled-idls';
import { suggestMethod, suggestService } from '../services/sails';

// Tie fixture: two services share the method name `Foo` so a typo
// equidistant from both produces no suggestion. Also includes a service
// pair (`Apxa`, `Apya`) for the service-tie case — both distance 1 from
// a typo like `Apza`.
const TIE_IDL = `constructor {
  New : ();
};

service Apxa {
  Foo : () -> bool;
  query Bar : () -> u8;
};

service Beta {
  Foo : () -> bool;
};

service Apya {
  query Anything : () -> u8;
};
`;

// Dedup fixture: a synthetic Sails-shaped object where one service has
// the same method name (`Ping`) declared in both `functions` and
// `queries`. Per-service deduping must collapse this to a single
// candidate, otherwise the `length === 1` check spuriously fails and the
// hint is suppressed. See PR #45 review (gemini-code-assist).
//
// We construct this directly rather than via the IDL parser because the
// parser may or may not allow same-name function/query pairs depending
// on grammar version, but the Sails runtime data model exposes them as
// independent `Record<string, …>` maps either way — which is what the
// suggestion code consumes.
function makeDupSails() {
  const fn = { args: [], returnTypeDef: null, docs: undefined };
  const services = {
    Main: { functions: { DoStuff: fn }, queries: {}, events: {} },
    Other: {
      functions: { Ping: fn },
      queries: { Ping: fn },
      events: {},
    },
  };
  return { services } as unknown as Parameters<typeof suggestMethod>[0];
}

describe('suggestMethod / suggestService', () => {
  let parser: SailsIdlParser;
  let vft: Sails;
  let tie: Sails;

  beforeAll(async () => {
    parser = await SailsIdlParser.new();
    vft = new Sails(parser);
    vft.parseIdl(VFT_STANDARD_IDL);
    tie = new Sails(parser);
    tie.parseIdl(TIE_IDL);
  });

  describe('suggestMethod — cross-service exact hit', () => {
    it('Vft/Name → VftMetadata/Name (Name lives only in VftMetadata)', () => {
      // Sanity: `Name` is NOT in Vft on the standard IDL.
      expect(vft.services['Vft'].queries['Name']).toBeUndefined();
      expect(vft.services['VftMetadata'].queries['Name']).toBeDefined();
      expect(suggestMethod(vft, 'Vft', 'Name')).toBe('VftMetadata/Name');
    });

    it('Vft/Symbol → VftMetadata/Symbol', () => {
      expect(suggestMethod(vft, 'Vft', 'Symbol')).toBe('VftMetadata/Symbol');
    });

    it('case-insensitive: Vft/name still suggests VftMetadata/Name', () => {
      expect(suggestMethod(vft, 'Vft', 'name')).toBe('VftMetadata/Name');
    });
  });

  describe('suggestMethod — fuzzy Levenshtein ≤2', () => {
    it('Vft/TotalSuplpy → Vft/TotalSupply (transposition, distance 2)', () => {
      expect(suggestMethod(vft, 'Vft', 'TotalSuplpy')).toBe('Vft/TotalSupply');
    });

    it('Vft/Aprove → Vft/Approve (single char insert)', () => {
      expect(suggestMethod(vft, 'Vft', 'Aprove')).toBe('Vft/Approve');
    });

    it('Vft/TotallyFake → no suggestion (distance > 2)', () => {
      expect(suggestMethod(vft, 'Vft', 'TotallyFake')).toBeNull();
    });

    it('Vft/CompletelyUnrelated → no suggestion', () => {
      expect(suggestMethod(vft, 'Vft', 'CompletelyUnrelated')).toBeNull();
    });
  });

  describe('suggestMethod — tie at minimum distance produces no suggestion', () => {
    it('Apxa/Fox → no suggestion (Apxa/Foo and Beta/Foo both distance 1)', () => {
      // `Fox` is distance 1 from both `Apxa/Foo` and `Beta/Foo`.
      expect(suggestMethod(tie, 'Apxa', 'Fox')).toBeNull();
    });
  });

  describe('suggestMethod — per-service dedup of function/query collisions', () => {
    // Regression for PR #45 review: when a method name exists in both
    // `functions` and `queries` of the same service, the suggestion code
    // must count it once. Otherwise the spurious duplicate trips the
    // `length === 1` tie-rejection and silently drops a valid hint.
    const dup = makeDupSails();

    it('exact case-insensitive: Main/ping → Other/Ping (not suppressed by dup)', () => {
      expect(suggestMethod(dup, 'Main', 'ping')).toBe('Other/Ping');
    });

    it('fuzzy: Main/Pong → Other/Ping (not suppressed by dup)', () => {
      expect(suggestMethod(dup, 'Main', 'Pong')).toBe('Other/Ping');
    });
  });

  describe('suggestService', () => {
    it('Vftt → Vft (single char insert, distance 1)', () => {
      expect(suggestService(vft, 'Vftt')).toBe('Vft');
    });

    it('case-insensitive: vft → Vft', () => {
      expect(suggestService(vft, 'vft')).toBe('Vft');
    });

    it('VftMetdata → VftMetadata (transposition, distance 2)', () => {
      expect(suggestService(vft, 'VftMetdata')).toBe('VftMetadata');
    });

    it('CompletelyMadeUp → no suggestion', () => {
      expect(suggestService(vft, 'CompletelyMadeUp')).toBeNull();
    });

    it('Apza → no suggestion when Apxa and Apya are both distance 1', () => {
      // `Apza` is distance 1 from both `Apxa` (subst z→x) and `Apya`
      // (subst z→y). Tie → null, no arbitrary pick.
      expect(suggestService(tie, 'Apza')).toBeNull();
    });
  });
});
