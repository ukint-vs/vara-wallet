import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KeyringPair$Json } from '@polkadot/keyring/types';
import { CliError, verbose } from '../utils';
import { writeUserFile } from '../utils/secure-file';
import { getConfigDir } from './config';

function getWalletsDir(): string {
  return path.join(getConfigDir(), 'wallets');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function walletPath(name: string): string {
  return path.join(getWalletsDir(), `${sanitizeName(name)}.json`);
}

export function saveWallet(name: string, json: KeyringPair$Json): string {
  const filePath = walletPath(name);
  if (fs.existsSync(filePath)) {
    throw new CliError(`Wallet "${name}" already exists at ${filePath}`, 'WALLET_EXISTS');
  }

  writeUserFile(filePath, JSON.stringify(json, null, 2) + '\n');
  return filePath;
}

export function loadWallet(name: string): KeyringPair$Json {
  const filePath = walletPath(name);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as KeyringPair$Json;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError(`Wallet "${name}" not found`, 'WALLET_NOT_FOUND');
    }
    throw new CliError(`Failed to read wallet "${name}": ${err instanceof Error ? err.message : err}`, 'WALLET_CORRUPTED');
  }
}

export interface WalletInfo {
  name: string;
  address: string;
  isDefault: boolean;
  encrypted: boolean;
}

export function listWallets(defaultAccount?: string): WalletInfo[] {
  const walletsDir = getWalletsDir();
  if (!fs.existsSync(walletsDir)) {
    return [];
  }

  const files = fs.readdirSync(walletsDir).filter((f) => f.endsWith('.json'));
  return files.map((file) => {
    const name = path.basename(file, '.json');
    try {
      const raw = fs.readFileSync(path.join(walletsDir, file), 'utf-8');
      const json = JSON.parse(raw) as KeyringPair$Json;
      return {
        name,
        address: json.address,
        isDefault: defaultAccount === name || defaultAccount === json.address,
        encrypted: isEncrypted(json),
      };
    } catch {
      return { name, address: '(corrupted)', isDefault: false, encrypted: false };
    }
  });
}

export function walletExists(name: string): boolean {
  return fs.existsSync(walletPath(name));
}

export function exportWallet(name: string): KeyringPair$Json {
  return loadWallet(name);
}

export function isEncrypted(json: KeyringPair$Json): boolean {
  const type = json.encoding?.type;
  if (Array.isArray(type)) return type.includes('xsalsa20-poly1305');
  return type === 'xsalsa20-poly1305';
}

function getPassphraseFilePath(): string {
  return path.join(getConfigDir(), '.passphrase');
}

export function readPassphraseFile(): string | undefined {
  try {
    const content = fs.readFileSync(getPassphraseFilePath(), 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export function ensurePassphraseFile(): string {
  const existing = readPassphraseFile();
  if (existing) return existing;

  const passphrase = crypto.randomBytes(32).toString('hex');
  const filePath = getPassphraseFilePath();
  writeUserFile(filePath, passphrase + '\n');
  verbose('Generated passphrase file at ' + filePath);
  return passphrase;
}
