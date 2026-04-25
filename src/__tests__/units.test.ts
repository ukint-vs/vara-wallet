import { varaToMinimal, minimalToVara, resolveAmount } from '../utils/units';

describe('varaToMinimal', () => {
  it('converts whole VARA to minimal units', () => {
    expect(varaToMinimal('1')).toBe(1_000_000_000_000n);
    expect(varaToMinimal('0')).toBe(0n);
    expect(varaToMinimal('100')).toBe(100_000_000_000_000n);
  });

  it('converts fractional VARA', () => {
    expect(varaToMinimal('1.5')).toBe(1_500_000_000_000n);
    expect(varaToMinimal('0.000000000001')).toBe(1n);
    expect(varaToMinimal('0.1')).toBe(100_000_000_000n);
  });

  it('truncates excess decimal places', () => {
    // 13 decimals → only first 12 used
    expect(varaToMinimal('0.0000000000019')).toBe(1n);
  });

  it('handles large amounts without overflow', () => {
    expect(varaToMinimal('1000000')).toBe(1_000_000_000_000_000_000n);
  });
});

describe('minimalToVara', () => {
  it('converts minimal units to VARA string', () => {
    expect(minimalToVara(1_000_000_000_000n)).toBe('1');
    expect(minimalToVara(0n)).toBe('0');
  });

  it('includes fractional part', () => {
    expect(minimalToVara(1_500_000_000_000n)).toBe('1.5');
    expect(minimalToVara(1n)).toBe('0.000000000001');
  });

  it('strips trailing zeros', () => {
    expect(minimalToVara(100_000_000_000n)).toBe('0.1');
  });
});

describe('resolveAmount', () => {
  it('converts VARA by default (units omitted)', () => {
    expect(resolveAmount('2')).toBe(2_000_000_000_000n);
  });

  it('converts VARA when units = "human"', () => {
    expect(resolveAmount('2', 'human')).toBe(2_000_000_000_000n);
  });

  it('passes through raw units when units = "raw"', () => {
    expect(resolveAmount('12345', 'raw')).toBe(12345n);
  });

  it('rejects invalid --units values with INVALID_UNITS', () => {
    let caught: unknown;
    try {
      resolveAmount('1', 'potato');
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('INVALID_UNITS');
  });

  it('rejects the legacy "vara" literal (renamed to human in 0.15)', () => {
    let caught: unknown;
    try {
      resolveAmount('1', 'vara');
    } catch (err) { caught = err; }
    expect((caught as { code?: string }).code).toBe('INVALID_UNITS');
  });

  it('rejects the legacy "token" literal (renamed to human in 0.15)', () => {
    let caught: unknown;
    try {
      resolveAmount('1', 'token');
    } catch (err) { caught = err; }
    expect((caught as { code?: string }).code).toBe('INVALID_UNITS');
  });
});
