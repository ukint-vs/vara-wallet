import * as fs from 'fs';
import * as path from 'path';

export interface VaraWalletConfig {
  wsEndpoint?: string;
  defaultAccount?: string;
  metaStorageUrl?: string;
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
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function updateConfig(updates: Partial<VaraWalletConfig>): void {
  const config = readConfig();
  writeConfig({ ...config, ...updates });
}

export { getConfigDir };
