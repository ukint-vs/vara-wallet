import { toMinimalUnits } from '../utils/units';

describe('toMinimalUnits', () => {
  it('converts with decimals=0', () => {
    expect(toMinimalUnits('42', 0)).toBe(42n);
    expect(toMinimalUnits('0', 0)).toBe(0n);
  });

  it('converts with decimals=6 (USDC-like)', () => {
    expect(toMinimalUnits('1', 6)).toBe(1_000_000n);
    expect(toMinimalUnits('100', 6)).toBe(100_000_000n);
  });

  it('converts with decimals=8 (BTC-like)', () => {
    expect(toMinimalUnits('1', 8)).toBe(100_000_000n);
  });

  it('converts with decimals=12 (VARA-like)', () => {
    expect(toMinimalUnits('1', 12)).toBe(1_000_000_000_000n);
  });

  it('converts with decimals=18 (ETH-like)', () => {
    expect(toMinimalUnits('1', 18)).toBe(1_000_000_000_000_000_000n);
  });

  it('converts with decimals=24 (high precision)', () => {
    expect(toMinimalUnits('1', 24)).toBe(10n ** 24n);
  });

  it('handles fractional amounts', () => {
    expect(toMinimalUnits('1.5', 6)).toBe(1_500_000n);
    expect(toMinimalUnits('0.000001', 6)).toBe(1n);
    expect(toMinimalUnits('1.123456', 6)).toBe(1_123_456n);
  });

  it('truncates excess decimals', () => {
    // 7 fractional digits with 6 decimals → only first 6 used
    expect(toMinimalUnits('1.1234569', 6)).toBe(1_123_456n);
  });

  it('handles zero amount', () => {
    expect(toMinimalUnits('0', 18)).toBe(0n);
    expect(toMinimalUnits('0.0', 6)).toBe(0n);
  });

  it('handles very large amounts without overflow', () => {
    // 10^18 tokens with 18 decimals = 10^36 minimal units
    expect(toMinimalUnits('1000000000000000000', 18)).toBe(10n ** 36n);
  });

  it('rejects negative amounts', () => {
    expect(() => toMinimalUnits('-1', 6)).toThrow('Invalid amount');
  });

  it('rejects malformed strings', () => {
    expect(() => toMinimalUnits('abc', 6)).toThrow('Invalid amount');
    expect(() => toMinimalUnits('', 6)).toThrow('Invalid amount');
    expect(() => toMinimalUnits('1.2.3', 6)).toThrow('Invalid amount');
    expect(() => toMinimalUnits('1e5', 6)).toThrow('Invalid amount');
  });

  it('rejects fractional input when decimals=0', () => {
    expect(() => toMinimalUnits('1.5', 0)).toThrow('Cannot have fractional digits when decimals is 0');
    expect(() => toMinimalUnits('0.1', 0)).toThrow('Cannot have fractional digits when decimals is 0');
  });

  it('rejects invalid decimals', () => {
    expect(() => toMinimalUnits('1', -1)).toThrow('Invalid decimals');
    expect(() => toMinimalUnits('1', 1.5)).toThrow('Invalid decimals');
  });
});
