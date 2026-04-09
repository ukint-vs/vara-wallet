import { cryptoWaitReady } from '@polkadot/util-crypto';
import { GearKeyring } from '@gear-js/api';
import { u8aToHex, hexToU8a, stringToU8a } from '@polkadot/util';
import { signatureVerify } from '@polkadot/util-crypto';

let alice: Awaited<ReturnType<typeof GearKeyring.fromSuri>>;

beforeAll(async () => {
  await cryptoWaitReady();
  alice = await GearKeyring.fromSuri('//Alice');
});

describe('sign (unit logic)', () => {
  it('signs a UTF-8 string and returns signature, publicKey, address', () => {
    const message = stringToU8a('hello world');
    const signature = alice.sign(message);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64); // sr25519 signature is 64 bytes
    expect(u8aToHex(signature)).toMatch(/^0x[0-9a-f]{128}$/);
    expect(u8aToHex(alice.publicKey)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(alice.address).toBeTruthy();
  });

  it('signs hex data', () => {
    const message = hexToU8a('0xdeadbeef');
    const signature = alice.sign(message);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });

  it('signs empty string (0 bytes)', () => {
    const message = stringToU8a('');
    const signature = alice.sign(message);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });

  it('signs empty hex 0x (0 bytes)', () => {
    const message = hexToU8a('0x');
    const signature = alice.sign(message);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);
  });
});

describe('verify (unit logic)', () => {
  it('verifies a valid signature returns isValid: true', () => {
    const message = stringToU8a('hello world');
    const signature = alice.sign(message);
    const result = signatureVerify(message, u8aToHex(signature), alice.address);

    expect(result.isValid).toBe(true);
    expect(result.crypto).toBe('sr25519');
  });

  it('returns isValid: false for wrong data', () => {
    const message = stringToU8a('hello world');
    const signature = alice.sign(message);
    const wrongMessage = stringToU8a('wrong data');
    const result = signatureVerify(wrongMessage, u8aToHex(signature), alice.address);

    expect(result.isValid).toBe(false);
  });

  it('returns isValid: false for wrong address', async () => {
    const message = stringToU8a('hello world');
    const signature = alice.sign(message);
    const bob = await GearKeyring.fromSuri('//Bob');
    const result = signatureVerify(message, u8aToHex(signature), bob.address);

    expect(result.isValid).toBe(false);
  });

  it('round-trips sign then verify for hex data', () => {
    const message = hexToU8a('0xcafebabe');
    const signature = alice.sign(message);
    const result = signatureVerify(message, u8aToHex(signature), alice.address);

    expect(result.isValid).toBe(true);
  });

  it('round-trips sign then verify for empty data', () => {
    const message = stringToU8a('');
    const signature = alice.sign(message);
    const result = signatureVerify(message, u8aToHex(signature), alice.address);

    expect(result.isValid).toBe(true);
  });
});

describe('wallet keys (unit logic)', () => {
  it('encodePkcs8 returns raw PKCS8 bytes for an unlocked keypair', () => {
    const pkcs8 = alice.encodePkcs8();
    expect(pkcs8).toBeInstanceOf(Uint8Array);
    expect(pkcs8.length).toBeGreaterThan(0);
    expect(u8aToHex(pkcs8)).toMatch(/^0x/);
  });

  it('publicKey is 32 bytes for sr25519', () => {
    expect(alice.publicKey.length).toBe(32);
    expect(alice.type).toBe('sr25519');
  });
});

describe('input validation', () => {
  it('hexToU8a is permissive — our command uses strict regex validation', () => {
    // hexToU8a does NOT throw on non-0x-prefixed or odd-length hex,
    // which is why the sign command validates with STRICT_HEX_RE before calling hexToU8a
    expect(hexToU8a('deadbeef')).toBeInstanceOf(Uint8Array);
    expect(hexToU8a('0xdead0')).toBeInstanceOf(Uint8Array);
  });

  it('strict hex regex rejects odd-length and invalid chars', () => {
    const STRICT_HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
    expect(STRICT_HEX_RE.test('0xdeadbeef')).toBe(true);
    expect(STRICT_HEX_RE.test('0x')).toBe(true);
    expect(STRICT_HEX_RE.test('0xdead0')).toBe(false); // odd length
    expect(STRICT_HEX_RE.test('deadbeef')).toBe(false); // no 0x prefix
    expect(STRICT_HEX_RE.test('0xzz')).toBe(false); // invalid chars
    expect(STRICT_HEX_RE.test('0xDEAD')).toBe(true); // uppercase OK
  });

  it('signatureVerify throws on wrong-length signature', () => {
    const message = stringToU8a('hello');
    expect(() => signatureVerify(message, '0xdead', alice.address)).toThrow();
  });
});
