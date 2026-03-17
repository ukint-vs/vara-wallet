import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KeyringPair$Json } from '@polkadot/keyring/types';

// Set VARA_WALLET_DIR before importing wallet-store
const testDir = path.join(os.tmpdir(), `vara-wallet-test-${Date.now()}`);
process.env.VARA_WALLET_DIR = testDir;

import { saveWallet, loadWallet, listWallets, walletExists } from '../services/wallet-store';

const mockJson: KeyringPair$Json = {
  address: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  encoded: 'encoded-data',
  encoding: { content: ['pkcs8', 'sr25519'], type: ['none'], version: '3' },
  meta: { name: 'test' },
};

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('saveWallet', () => {
  it('saves a wallet file', () => {
    const filePath = saveWallet('test1', mockJson);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(content.address).toBe(mockJson.address);
  });

  it('rejects duplicate wallet names', () => {
    saveWallet('duplicate-test', mockJson);
    expect(() => saveWallet('duplicate-test', mockJson)).toThrow(/already exists/);
  });

  it('sets restrictive file permissions', () => {
    const filePath = saveWallet('perms-test', mockJson);
    const stats = fs.statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });

  it('sanitizes wallet names', () => {
    const filePath = saveWallet('my wallet!@#$', mockJson);
    expect(path.basename(filePath)).toBe('my_wallet____.json');
  });
});

describe('loadWallet', () => {
  it('loads a saved wallet', () => {
    saveWallet('load-test', mockJson);
    const loaded = loadWallet('load-test');
    expect(loaded.address).toBe(mockJson.address);
  });

  it('throws for non-existent wallet', () => {
    expect(() => loadWallet('nonexistent')).toThrow(/not found/);
  });

  it('throws WALLET_NOT_FOUND error code', () => {
    try {
      loadWallet('nonexistent');
    } catch (err: any) {
      expect(err.code).toBe('WALLET_NOT_FOUND');
    }
  });
});

describe('listWallets', () => {
  it('lists saved wallets', () => {
    const wallets = listWallets();
    expect(wallets.length).toBeGreaterThan(0);
    expect(wallets.some((w) => w.name === 'test1')).toBe(true);
  });

  it('marks default wallet', () => {
    const wallets = listWallets('test1');
    const defaultWallet = wallets.find((w) => w.name === 'test1');
    expect(defaultWallet?.isDefault).toBe(true);
  });
});

describe('walletExists', () => {
  it('returns true for existing wallet', () => {
    expect(walletExists('test1')).toBe(true);
  });

  it('returns false for non-existent wallet', () => {
    expect(walletExists('no-such-wallet')).toBe(false);
  });
});
