import { Command } from 'commander';
import { readConfig, updateConfig, VaraWalletConfig } from '../services/config';
import { output, CliError } from '../utils';

const VALID_KEYS: Array<keyof VaraWalletConfig> = [
  'wsEndpoint',
  'defaultAccount',
  'dexFactoryAddress',
  'faucetUrl',
];

const NETWORK_MAP: Record<string, string> = {
  mainnet: 'wss://rpc.vara.network',
  testnet: 'wss://testnet.vara.network',
  local: 'ws://localhost:9944',
};

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Manage CLI configuration');

  config
    .command('list')
    .description('Show all configuration values')
    .action(() => {
      output(readConfig());
    });

  config
    .command('get')
    .description('Get a configuration value')
    .argument('<key>', `config key (${VALID_KEYS.join(', ')})`)
    .action((key: string) => {
      const cfg = readConfig();

      if (key === 'network') {
        const network = Object.entries(NETWORK_MAP).find(([, url]) => url === cfg.wsEndpoint)?.[0];
        output({ key: 'network', value: network ?? null });
        return;
      }

      if (!VALID_KEYS.includes(key as keyof VaraWalletConfig)) {
        throw new CliError(
          `Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(', ')}, network`,
          'INVALID_CONFIG_KEY',
        );
      }
      const value = cfg[key as keyof VaraWalletConfig];
      output({ key, value: value ?? null });
    });

  config
    .command('set')
    .description('Set a configuration value')
    .argument('<key>', `config key (${VALID_KEYS.join(', ')}) or "network"`)
    .argument('<value>', 'value to set')
    .action((key: string, value: string) => {
      // Convenience alias: "config set network testnet" → wsEndpoint
      if (key === 'network') {
        const url = NETWORK_MAP[value];
        if (!url) {
          throw new CliError(
            `Unknown network "${value}". Valid networks: ${Object.keys(NETWORK_MAP).join(', ')}`,
            'INVALID_NETWORK',
          );
        }
        updateConfig({ wsEndpoint: url });
        output({ key: 'wsEndpoint', value: url, network: value });
        return;
      }

      if (!VALID_KEYS.includes(key as keyof VaraWalletConfig)) {
        throw new CliError(
          `Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(', ')}, network`,
          'INVALID_CONFIG_KEY',
        );
      }

      updateConfig({ [key]: value } as Partial<VaraWalletConfig>);
      output({ key, value });
    });
}

export { NETWORK_MAP };
