import { GearKeyring } from '@gear-js/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { CliError, verbose, addressToHex } from '../utils';
import { readConfig } from './config';
import { loadWallet, isEncrypted, readPassphraseFile } from './wallet-store';

export interface AccountOptions {
  seed?: string;
  mnemonic?: string;
  account?: string;
}

export function resolvePassphrase(): string | undefined {
  // 1. File-based (primary, agent-safe)
  const fromFile = readPassphraseFile();
  if (fromFile) return fromFile;

  // 2. Env var fallback (CI/Docker)
  return process.env.VARA_PASSPHRASE || undefined;
}

function loadAndDecryptWallet(name: string): KeyringPair {
  const json = loadWallet(name);
  const passphrase = resolvePassphrase();

  if (isEncrypted(json) && !passphrase) {
    throw new CliError(
      `Wallet "${name}" is encrypted. Create ~/.vara-wallet/.passphrase or set VARA_PASSPHRASE.`,
      'PASSPHRASE_REQUIRED',
    );
  }

  if (!isEncrypted(json) && passphrase) {
    verbose(`Warning: Wallet "${name}" is not encrypted. Passphrase not used. Consider re-creating with encryption.`);
  }

  try {
    return GearKeyring.fromJson(json, isEncrypted(json) ? passphrase : undefined);
  } catch (err) {
    if (isEncrypted(json)) {
      throw new CliError(
        `Failed to decrypt wallet "${name}". Check your passphrase.`,
        'DECRYPT_FAILED',
      );
    }
    throw err;
  }
}

/**
 * Account resolution chain:
 * 1. --seed flag
 * 2. VARA_SEED env
 * 3. --mnemonic flag
 * 4. VARA_MNEMONIC env
 * 5. --account flag (wallet file lookup)
 * 6. Default account from config
 */
export async function resolveAccount(options: AccountOptions): Promise<KeyringPair> {
  // 1. --seed flag
  if (options.seed) {
    verbose(`Using account from --seed flag`);
    return GearKeyring.fromSuri(options.seed);
  }

  // 2. VARA_SEED env
  const envSeed = process.env.VARA_SEED;
  if (envSeed) {
    verbose(`Using account from VARA_SEED env`);
    return GearKeyring.fromSuri(envSeed);
  }

  // 3. --mnemonic flag
  if (options.mnemonic) {
    verbose(`Using account from --mnemonic flag`);
    return GearKeyring.fromMnemonic(options.mnemonic);
  }

  // 4. VARA_MNEMONIC env
  const envMnemonic = process.env.VARA_MNEMONIC;
  if (envMnemonic) {
    verbose(`Using account from VARA_MNEMONIC env`);
    return GearKeyring.fromMnemonic(envMnemonic);
  }

  // 5. --account flag (wallet file lookup)
  if (options.account) {
    verbose(`Using account from wallet "${options.account}"`);
    return loadAndDecryptWallet(options.account);
  }

  // 6. Default account from config
  const config = readConfig();
  if (config.defaultAccount) {
    verbose(`Using default account "${config.defaultAccount}"`);
    return loadAndDecryptWallet(config.defaultAccount);
  }

  throw new CliError(
    'No account specified. Use --seed, --mnemonic, --account, or set VARA_SEED / VARA_MNEMONIC env var.',
    'NO_ACCOUNT',
  );
}

/**
 * Resolve account address for read-only queries.
 * Falls back to a provided address string if no account is configured.
 * Always returns a normalized hex address (0x...).
 */
export async function resolveAddress(addressOrOptions: string | undefined, options: AccountOptions): Promise<`0x${string}`> {
  if (addressOrOptions) {
    return addressToHex(addressOrOptions);
  }

  try {
    const account = await resolveAccount(options);
    return addressToHex(account.address);
  } catch {
    throw new CliError(
      'No address specified. Provide an address argument or configure an account.',
      'NO_ADDRESS',
    );
  }
}
