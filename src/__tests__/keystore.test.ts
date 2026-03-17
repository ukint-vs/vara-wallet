import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KeyringPair$Json } from '@polkadot/keyring/types';

// Set VARA_WALLET_DIR before importing modules
const testDir = path.join(os.tmpdir(), `vara-wallet-keystore-test-${Date.now()}`);
process.env.VARA_WALLET_DIR = testDir;

import {
  isEncrypted,
  readPassphraseFile,
  ensurePassphraseFile,
  listWallets,
  saveWallet,
} from '../services/wallet-store';

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('isEncrypted', () => {
  it('returns true for xsalsa20-poly1305 encrypted JSON', () => {
    const json: KeyringPair$Json = {
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      encoded: 'encrypted-data',
      encoding: { content: ['pkcs8', 'sr25519'], type: ['xsalsa20-poly1305'], version: '3' },
      meta: { name: 'test' },
    };
    expect(isEncrypted(json)).toBe(true);
  });

  it('returns false for unencrypted JSON (type: none)', () => {
    const json: KeyringPair$Json = {
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      encoded: 'plain-data',
      encoding: { content: ['pkcs8', 'sr25519'], type: ['none'], version: '3' },
      meta: { name: 'test' },
    };
    expect(isEncrypted(json)).toBe(false);
  });

  it('returns false for missing encoding', () => {
    const json = {
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      encoded: 'data',
      meta: { name: 'test' },
    } as unknown as KeyringPair$Json;
    expect(isEncrypted(json)).toBe(false);
  });

  it('handles string type (non-array)', () => {
    const json = {
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      encoded: 'data',
      encoding: { content: ['pkcs8', 'sr25519'], type: 'xsalsa20-poly1305', version: '3' },
      meta: { name: 'test' },
    } as unknown as KeyringPair$Json;
    expect(isEncrypted(json)).toBe(true);
  });
});

describe('readPassphraseFile', () => {
  const passphraseFilePath = path.join(testDir, '.passphrase');

  afterEach(() => {
    try {
      fs.unlinkSync(passphraseFilePath);
    } catch {
      // ignore
    }
  });

  it('reads passphrase from file', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(passphraseFilePath, 'my-secret-passphrase\n', { mode: 0o600 });
    expect(readPassphraseFile()).toBe('my-secret-passphrase');
  });

  it('returns undefined if file does not exist', () => {
    expect(readPassphraseFile()).toBeUndefined();
  });

  it('trims whitespace', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(passphraseFilePath, '  pass phrase  \n', { mode: 0o600 });
    expect(readPassphraseFile()).toBe('pass phrase');
  });

  it('treats empty file as undefined', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(passphraseFilePath, '\n', { mode: 0o600 });
    expect(readPassphraseFile()).toBeUndefined();
  });
});

describe('ensurePassphraseFile', () => {
  const passphraseFilePath = path.join(testDir, '.passphrase');

  afterEach(() => {
    try {
      fs.unlinkSync(passphraseFilePath);
    } catch {
      // ignore
    }
  });

  it('creates passphrase file with 0600 perms if not exists', () => {
    fs.mkdirSync(testDir, { recursive: true });
    const passphrase = ensurePassphraseFile();
    expect(passphrase).toHaveLength(64); // 32 bytes hex
    expect(fs.existsSync(passphraseFilePath)).toBe(true);
    const stats = fs.statSync(passphraseFilePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });

  it('returns existing passphrase without overwriting', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(passphraseFilePath, 'existing-passphrase\n', { mode: 0o600 });
    const passphrase = ensurePassphraseFile();
    expect(passphrase).toBe('existing-passphrase');
  });
});

describe('listWallets encrypted field', () => {
  it('shows encrypted: false for unencrypted wallets', () => {
    const json: KeyringPair$Json = {
      address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      encoded: 'data',
      encoding: { content: ['pkcs8', 'sr25519'], type: ['none'], version: '3' },
      meta: { name: 'list-test' },
    };
    saveWallet('list-unencrypted', json);
    const wallets = listWallets();
    const w = wallets.find((w) => w.name === 'list-unencrypted');
    expect(w?.encrypted).toBe(false);
  });

  it('shows encrypted: true for encrypted wallets', () => {
    const json: KeyringPair$Json = {
      address: '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
      encoded: 'encrypted-data',
      encoding: { content: ['pkcs8', 'sr25519'], type: ['xsalsa20-poly1305'], version: '3' },
      meta: { name: 'list-test-enc' },
    };
    saveWallet('list-encrypted', json);
    const wallets = listWallets();
    const w = wallets.find((w) => w.name === 'list-encrypted');
    expect(w?.encrypted).toBe(true);
  });
});
