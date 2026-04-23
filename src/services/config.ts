import * as fs from 'fs';
import * as path from 'path';
import { writeUserFile } from '../utils/secure-file';

export interface VaraWalletConfig {
  wsEndpoint?: string;
  defaultAccount?: string;
  metaStorageUrl?: string;
  dexFactoryAddress?: string;
  faucetUrl?: string;
}

function getConfigDir(): string {
  return process.env.VARA_WALLET_DIR || path.join(process.env.HOME || '~', '.vara-wallet');
}

function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function readConfig(): VaraWalletConfig {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as VaraWalletConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: VaraWalletConfig): void {
  writeUserFile(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

export function updateConfig(updates: Partial<VaraWalletConfig>): void {
  const config = readConfig();
  writeConfig({ ...config, ...updates });
}

export { getConfigDir };
