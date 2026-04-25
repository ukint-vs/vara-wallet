import { CliError } from './errors';

const VARA_DECIMALS = 12;
const MULTIPLIER = BigInt(10 ** VARA_DECIMALS);

/**
 * Convert a human-readable VARA amount to minimal units (planck-equivalent).
 * Supports decimal values: "1.5" → 1_500_000_000_000
 */
export function varaToMinimal(amount: string): bigint {
  const parts = amount.split('.');
  const whole = parts[0] || '0';
  let fractional = (parts[1] || '').slice(0, VARA_DECIMALS);
  fractional = fractional.padEnd(VARA_DECIMALS, '0');

  const wholeBig = BigInt(whole) * MULTIPLIER;
  const fractionalBig = BigInt(fractional);

  return wholeBig + fractionalBig;
}

/**
 * Convert minimal units to human-readable amount.
 * Returns a string with up to `decimals` decimal places, trailing zeros trimmed.
 * Defaults to 12 decimals (VARA).
 */
export function minimalToVara(minimal: bigint, decimals: number = VARA_DECIMALS): string {
  const multiplier = 10n ** BigInt(decimals);
  const whole = minimal / multiplier;
  const fractional = minimal % multiplier;

  if (fractional === 0n) {
    return whole.toString();
  }

  const fractionalStr = fractional.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fractionalStr}`;
}

/**
 * Convert a human-readable token amount to minimal units using dynamic decimals.
 * Uses string-based math to avoid floating-point issues.
 * Uses 10n ** BigInt(decimals) to avoid overflow for decimals >= 16.
 *
 * Examples: toMinimalUnits("1.5", 6) → 1500000n
 *           toMinimalUnits("1", 18) → 1000000000000000000n
 */
export function toMinimalUnits(amount: string, decimals: number): bigint {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: "${amount}". Must be a non-negative number.`);
  }

  const parts = trimmed.split('.');
  const whole = parts[0] || '0';
  const rawFractional = parts[1] || '';

  if (decimals === 0 && rawFractional.length > 0 && BigInt(rawFractional) !== 0n) {
    throw new Error(`Invalid amount: "${amount}". Cannot have a non-zero fractional value when decimals is 0.`);
  }

  let fractional = rawFractional.slice(0, decimals);
  fractional = fractional.padEnd(decimals, '0');

  const multiplier = 10n ** BigInt(decimals);
  const wholeBig = BigInt(whole) * multiplier;
  const fractionalBig = fractional ? BigInt(fractional) : 0n;

  return wholeBig + fractionalBig;
}

/**
 * Resolve a native VARA amount based on the --units flag.
 *
 * Vocabulary (unified in 0.15.0):
 *   - `human` (default): multiply by 10^12 (VARA → minimal units).
 *   - `raw`            : pass through as a bigint.
 *
 * Anything else throws INVALID_UNITS. The legacy `vara` literal (0.10.0
 * vocabulary) is intentionally rejected — npm registry was on 0.10.0
 * when this rename landed, and the audience for the new vocabulary is
 * post-0.10.0 only.
 *
 * For VFT / DEX commands the same `human|raw` vocabulary applies but
 * `human` means "use the token's declared decimals", not VARA's 12.
 * Those resolvers live in their respective command files; this helper
 * is native-VARA only.
 *
 * Imports `CliError` directly from `./errors` to keep the helper
 * usable from any utils consumer without circular dependency risk.
 */
export type UnitsFlag = 'human' | 'raw';

/**
 * Validate the `--units` value against the unified vocabulary.
 * Returns the typed flag (or `undefined` for omitted) and throws
 * `INVALID_UNITS` for everything else — including the legacy literals
 * `vara` / `token` from pre-0.15. Single source of truth used by
 * native (`resolveAmount`), VFT (`resolveVftAmount`), and DEX
 * (`resolveTokenAmount`) so future vocabulary changes are one edit.
 */
export function validateUnits(units: string | undefined): UnitsFlag | undefined {
  if (units === undefined) return undefined;
  if (units !== 'human' && units !== 'raw') {
    throw new CliError(
      `Invalid --units value: "${units}". Must be "human" or "raw".`,
      'INVALID_UNITS',
    );
  }
  return units;
}

export function resolveAmount(amount: string, units?: string): bigint {
  const u = validateUnits(units);
  if (u === 'raw') return BigInt(amount);
  return varaToMinimal(amount);
}
