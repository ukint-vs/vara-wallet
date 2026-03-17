import { Command } from 'commander';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError } from '../utils';

export function registerCodeCommand(program: Command): void {
  const code = program.command('code').description('Code operations');

  code
    .command('upload')
    .description('Upload code (WASM) to the chain')
    .argument('<wasm>', 'path to .wasm file')
    .action(async (wasmPath: string) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      if (!fs.existsSync(wasmPath)) {
        throw new CliError(`WASM file not found: ${wasmPath}`, 'FILE_NOT_FOUND');
      }

      const wasmBytes = fs.readFileSync(wasmPath);

      verbose('Uploading code...');

      const { codeHash, extrinsic } = await api.code.upload(wasmBytes);
      const txResult = await executeTx(api, extrinsic, account);

      output({
        codeId: codeHash,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        events: txResult.events,
      });
    });

  code
    .command('info')
    .description('Get code information')
    .argument('<codeId>', 'code ID (0x...)')
    .action(async (codeId: string) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose(`Fetching info for code ${codeId}`);

      const exists = await api.code.exists(codeId);
      if (!exists) {
        throw new CliError(`Code ${codeId} not found on chain`, 'CODE_NOT_FOUND');
      }

      let metaHash: string | null = null;
      try {
        metaHash = await api.code.metaHash(codeId as `0x${string}`);
      } catch {
        // Code may not have metadata
      }

      let staticPages: number | null = null;
      try {
        staticPages = await api.code.staticPages(codeId as `0x${string}`);
      } catch {
        // May not be available
      }

      output({
        codeId,
        exists: true,
        metaHash,
        staticPages,
      });
    });

  code
    .command('list')
    .description('List all code IDs on chain')
    .option('--count <count>', 'number of code IDs to list')
    .action(async (options: { count?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose('Fetching code list...');

      const count = options.count ? parseInt(options.count, 10) : undefined;
      const codes = await api.code.all(count);

      output(codes);
    });
}
