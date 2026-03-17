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
 * Convert minimal units to human-readable VARA amount.
 * Returns a string with up to 12 decimal places, trailing zeros trimmed.
 */
export function minimalToVara(minimal: bigint): string {
  const whole = minimal / MULTIPLIER;
  const fractional = minimal % MULTIPLIER;

  if (fractional === 0n) {
    return whole.toString();
  }

  const fractionalStr = fractional.toString().padStart(VARA_DECIMALS, '0').replace(/0+$/, '');
  return `${whole}.${fractionalStr}`;
}

/**
 * Resolve amount based on --units flag.
 * Default: treat as VARA (multiply by 10^12).
 * With --units raw: passthrough as-is.
 */
export function resolveAmount(amount: string, unitsRaw?: boolean): bigint {
  if (unitsRaw) {
    return BigInt(amount);
  }
  return varaToMinimal(amount);
}
