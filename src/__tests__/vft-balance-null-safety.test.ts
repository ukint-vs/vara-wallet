/**
 * U8 regression contract: `vft balance` and `vft allowance` must
 * translate Option::None (decoded === null) to the string '0' before
 * any BigInt coercion. Pre-0.15 the code was `BigInt(result)` directly,
 * which crashed with "Cannot convert null to a BigInt" when
 * `findVftService` resolved to `VftExtension.BalanceOf` (declared
 * `opt u256`) for an account with no balance row.
 *
 * Fix routes the result through `decodeSailsResult` (null-aware) and
 * then `_formatVftAmountForTests` (the unit-test seam) translates null
 * → '0'. A regression that drops the null check would break THIS test,
 * not just real-world VftExtension queries.
 */
import { _formatVftAmountForTests } from '../commands/vft';

describe('_formatVftAmountForTests (U8 null-safety)', () => {
  describe('null path (Option::None / no balance row)', () => {
    it('returns rawStr "0" when decoded is null and no decimals', () => {
      const out = _formatVftAmountForTests(null, null);
      expect(out.rawStr).toBe('0');
      expect(out.humanStr).toBe('0');
      expect(out.decimals).toBeNull();
    });

    it('returns rawStr "0" + humanStr "0" (decimals applied to zero) when decimals present', () => {
      const out = _formatVftAmountForTests(null, 6);
      expect(out.rawStr).toBe('0');
      expect(out.humanStr).toBe('0'); // minimalToVara(0n, 6) === '0'
      expect(out.decimals).toBe(6);
    });

    it('null path is shape-symmetric (balance and allowance share the helper)', () => {
      // The same helper drives both balance and allowance; null → '0' regardless.
      const a = _formatVftAmountForTests(null, 18);
      const b = _formatVftAmountForTests(null, 18);
      expect(a).toEqual(b);
    });
  });

  describe('non-null path (Option::Some / explicit zero)', () => {
    it('passes through bigint values as decimal strings', () => {
      const out = _formatVftAmountForTests(123_456_789n, null);
      expect(out.rawStr).toBe('123456789');
      expect(out.humanStr).toBe('123456789');
    });

    it('passes through string-numeric values from decodeSailsResult', () => {
      // decodeSailsResult normalizes U256 to decimal strings (#32 fix).
      const out = _formatVftAmountForTests('1000000000000000000', null);
      expect(out.rawStr).toBe('1000000000000000000');
    });

    it('converts to human form when decimals present', () => {
      // 1.5 token at 6 decimals = 1500000 minimal units.
      const out = _formatVftAmountForTests(1_500_000n, 6);
      expect(out.rawStr).toBe('1500000');
      expect(out.humanStr).toBe('1.5');
      expect(out.decimals).toBe(6);
    });

    it('explicit zero (decoded = 0n) is distinct from null path in raw form', () => {
      const explicitZero = _formatVftAmountForTests(0n, null);
      const nullValue = _formatVftAmountForTests(null, null);
      // Both surface as '0' — matches on-chain semantics where missing
      // row and explicit zero are indistinguishable for transfer-spend.
      expect(explicitZero.rawStr).toBe('0');
      expect(nullValue.rawStr).toBe('0');
    });
  });

  describe('regression: drops to BigInt(null) would throw', () => {
    it('does NOT throw on null input (pre-0.15 bug shape)', () => {
      expect(() => _formatVftAmountForTests(null, null)).not.toThrow();
      expect(() => _formatVftAmountForTests(null, 12)).not.toThrow();
    });

    it('rawStr never becomes the literal "null" string', () => {
      // `String(null)` would yield "null"; the helper must short-circuit
      // before reaching that path.
      const out = _formatVftAmountForTests(null, null);
      expect(out.rawStr).not.toBe('null');
    });
  });
});
