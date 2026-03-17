import { Command } from 'commander';
import { GearKeyring } from '@gear-js/api';
import { writeConfig, readConfig, getConfigDir } from '../services/config';
import { saveWallet } from '../services/wallet-store';
import { output, verbose } from '../utils';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize vara-wallet: create config directory, generate a default wallet')
    .option('--name <name>', 'name for the generated wallet', 'default')
    .action(async (options: { name: string }) => {
      const configDir = getConfigDir();
      verbose(`Initializing vara-wallet at ${configDir}`);

      // Check if already initialized
      const existing = readConfig();
      if (existing.defaultAccount) {
        verbose(`Already initialized with default account "${existing.defaultAccount}"`);
      }

      // Generate a new wallet
      const { keyring, mnemonic, seed, json } = await GearKeyring.create(options.name);
      const filePath = saveWallet(options.name, json);

      // Set as default
      writeConfig({
        ...readConfig(),
        defaultAccount: options.name,
      });

      verbose(`Wallet saved to ${filePath}`);

      output({
        address: keyring.address,
        name: options.name,
        mnemonic,
        seed,
        path: filePath,
        configDir,
      });
    });
}
