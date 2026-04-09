import { Command } from 'commander';
import { GearKeyring } from '@gear-js/api';
import { u8aToHex } from '@polkadot/util';
import { saveWallet, loadWallet, listWallets, exportWallet, isEncrypted, readPassphraseFile, ensurePassphraseFile } from '../services/wallet-store';
import { resolvePassphrase } from '../services/account';
import { readConfig, updateConfig } from '../services/config';
import { output, verbose, CliError } from '../utils';

export function registerWalletCommand(program: Command): void {
  const wallet = program.command('wallet').description('Manage wallets');

  wallet
    .command('create')
    .description('Create a new wallet')
    .option('--name <name>', 'wallet name', 'default')
    .option('--passphrase <passphrase>', 'passphrase to encrypt the wallet')
    .option('--no-encrypt', 'create unencrypted wallet (not recommended)')
    .option('--show-secret', 'include mnemonic and seed in output')
    .action(async (options: { name: string; passphrase?: string; encrypt: boolean; showSecret?: boolean }) => {
      verbose(`Creating wallet "${options.name}"`);

      let passphrase: string | undefined;
      if (options.encrypt) {
        // Resolve passphrase: --passphrase flag → file → env → auto-generate
        passphrase = options.passphrase || readPassphraseFile() || process.env.VARA_PASSPHRASE || undefined;
        if (!passphrase) {
          passphrase = ensurePassphraseFile();
        }
      }

      const result = await GearKeyring.create(options.name, passphrase);
      const filePath = saveWallet(options.name, result.json);

      const out: Record<string, unknown> = {
        address: result.keyring.address,
        name: options.name,
        encrypted: options.encrypt,
        path: filePath,
      };

      if (options.showSecret) {
        out.mnemonic = result.mnemonic;
        out.seed = result.seed;
      }

      output(out);
    });

  wallet
    .command('import')
    .description('Import a wallet from mnemonic, seed, or JSON keystore')
    .option('--name <name>', 'wallet name', 'imported')
    .option('--mnemonic <mnemonic>', 'mnemonic phrase')
    .option('--seed <seed>', 'seed (hex or SURI like //Alice)')
    .option('--json <path>', 'path to JSON keystore file')
    .option('--passphrase <passphrase>', 'passphrase to encrypt the imported wallet')
    .option('--no-encrypt', 'store unencrypted (not recommended)')
    .action(async (options: { name: string; mnemonic?: string; seed?: string; json?: string; passphrase?: string; encrypt: boolean }, command: Command) => {
      // Merge with global opts so --seed/--mnemonic work regardless of which
      // Commander level parsed them (global program vs. subcommand).
      const allOpts = command.optsWithGlobals() as typeof options;
      let keyring;

      if (allOpts.mnemonic) {
        keyring = await GearKeyring.fromMnemonic(allOpts.mnemonic, allOpts.name);
      } else if (allOpts.seed) {
        keyring = await GearKeyring.fromSuri(allOpts.seed, allOpts.name);
      } else if (allOpts.json) {
        const fs = await import('fs');
        const raw = fs.readFileSync(allOpts.json, 'utf-8');
        const jsonData = JSON.parse(raw);
        const importPassphrase = allOpts.passphrase || readPassphraseFile() || process.env.VARA_PASSPHRASE || undefined;
        try {
          keyring = GearKeyring.fromJson(jsonData, importPassphrase);
        } catch {
          throw new CliError(
            'Failed to decrypt imported JSON. The file may use a different passphrase.',
            'IMPORT_DECRYPT_FAILED',
          );
        }
      } else {
        throw new CliError(
          'Provide --mnemonic, --seed, or --json to import a wallet',
          'MISSING_IMPORT_SOURCE',
        );
      }

      let passphrase: string | undefined;
      if (allOpts.encrypt) {
        passphrase = allOpts.passphrase || readPassphraseFile() || process.env.VARA_PASSPHRASE || undefined;
        if (!passphrase) {
          passphrase = ensurePassphraseFile();
        }
      }

      const json = keyring.toJson(passphrase);
      const filePath = saveWallet(allOpts.name, json);

      output({
        address: keyring.address,
        name: allOpts.name,
        encrypted: allOpts.encrypt,
        path: filePath,
      });
    });

  wallet
    .command('list')
    .description('List all wallets')
    .action(() => {
      const config = readConfig();
      const wallets = listWallets(config.defaultAccount);

      output(wallets);
    });

  wallet
    .command('export')
    .description('Export a wallet as JSON keystore')
    .argument('<name>', 'wallet name')
    .option('--decrypt', 'export decrypted JSON (exposes private key)')
    .option('--output <path>', 'save JSON to file instead of stdout')
    .action(async (name: string, options: { decrypt?: boolean; output?: string }) => {
      const json = exportWallet(name);

      let result = json;
      if (options.decrypt && isEncrypted(json)) {
        const passphrase = resolvePassphrase();
        if (!passphrase) {
          throw new CliError(
            `Wallet "${name}" is encrypted. Create ~/.vara-wallet/.passphrase or set VARA_PASSPHRASE to decrypt.`,
            'PASSPHRASE_REQUIRED',
          );
        }
        try {
          const keyring = GearKeyring.fromJson(json, passphrase);
          result = keyring.toJson();
        } catch {
          throw new CliError(
            `Failed to decrypt wallet "${name}". Check your passphrase.`,
            'DECRYPT_FAILED',
          );
        }
      }

      if (options.output) {
        const fs = await import('fs');
        const path = await import('path');
        const resolved = path.resolve(options.output);
        fs.writeFileSync(resolved, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
        output({ path: resolved, encrypted: isEncrypted(result) });
        return;
      }

      output(result);
    });

  wallet
    .command('keys')
    .description('Export raw key material from a wallet (exposes secret key)')
    .argument('<name>', 'wallet name')
    .action((name: string) => {
      const json = loadWallet(name);
      const passphrase = isEncrypted(json) ? resolvePassphrase() : undefined;

      if (isEncrypted(json) && !passphrase) {
        throw new CliError(
          `Wallet "${name}" is encrypted. Create ~/.vara-wallet/.passphrase or set VARA_PASSPHRASE to decrypt.`,
          'PASSPHRASE_REQUIRED',
        );
      }

      let keyring;
      try {
        keyring = GearKeyring.fromJson(json, passphrase);
      } catch {
        throw new CliError(
          `Failed to decrypt wallet "${name}". Check your passphrase.`,
          'DECRYPT_FAILED',
        );
      }

      // encodePkcs8() without passphrase returns the raw PKCS8-encoded keypair
      // which contains the full secret key (miniSecretKey + public key)
      const pkcs8 = keyring.encodePkcs8();

      output({
        address: keyring.address,
        publicKey: u8aToHex(keyring.publicKey),
        secretKeyPkcs8: u8aToHex(pkcs8),
        type: keyring.type,
      });
    });

  wallet
    .command('default')
    .description('Get or set the default wallet')
    .argument('[name]', 'wallet name to set as default')
    .action((name?: string) => {
      if (name) {
        // Verify wallet exists by loading it
        loadWallet(name);
        updateConfig({ defaultAccount: name });
        verbose(`Default wallet set to "${name}"`);
        output({ name, status: 'set' });
      } else {
        const config = readConfig();
        if (!config.defaultAccount) {
          throw new CliError('No default account configured', 'NO_DEFAULT');
        }
        const json = loadWallet(config.defaultAccount);
        output({
          name: config.defaultAccount,
          address: json.address,
        });
      }
    });
}
