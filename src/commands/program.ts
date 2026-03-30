import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { executeTx } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, resolveAmount, addressToHex } from '../utils';

export function registerProgramCommand(program: Command): void {
  const prog = program.command('program').description('Program operations');

  prog
    .command('upload')
    .description('Upload a program from WASM file')
    .argument('<wasm>', 'path to .wasm file')
    .option('--payload <payload>', 'init payload (hex or JSON)', '0x')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (wasmPath: string, options: {
      payload: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
      voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      if (!fs.existsSync(wasmPath)) {
        throw new CliError(`WASM file not found: ${wasmPath}`, 'FILE_NOT_FOUND');
      }

      const code = fs.readFileSync(wasmPath);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas for program upload...');
        const gasInfo = await api.program.calculateGas.initUpload(
          addressToHex(account.address),
          code,
          options.payload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);
      }

      if (options.voucher) {
        const accountHex = addressToHex(account.address);
        await validateVoucher(api, accountHex, options.voucher);
      }

      verbose('Uploading program...');

      const uploadResult = api.program.upload({
        code,
        initPayload: options.payload,
        gasLimit,
        value,
        salt: options.salt as `0x${string}` | undefined,
      }, meta);

      const finalTx = options.voucher
        ? api.voucher.call(options.voucher, { SendMessage: uploadResult.extrinsic })
        : uploadResult.extrinsic;

      const txResult = await executeTx(api, finalTx, account);

      output({
        programId: uploadResult.programId,
        codeId: uploadResult.codeId,
        salt: uploadResult.salt,
        voucherId: options.voucher ?? null,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        blockNumber: txResult.blockNumber,
        events: txResult.events,
      });
    });

  prog
    .command('deploy')
    .description('Create a program from an existing code ID')
    .argument('<codeId>', 'code ID to deploy from (0x...)')
    .option('--payload <payload>', 'init payload (hex or JSON)', '0x')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (codeId: string, options: {
      payload: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
      voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      let meta: ProgramMetadata | undefined;
      if (options.metadata) {
        const metaHex = fs.readFileSync(options.metadata, 'utf-8').trim();
        meta = ProgramMetadata.from(metaHex);
      }

      let gasLimit: bigint;
      if (options.gasLimit) {
        gasLimit = BigInt(options.gasLimit);
      } else {
        verbose('Calculating gas for program creation...');
        const gasInfo = await api.program.calculateGas.initCreate(
          addressToHex(account.address),
          codeId as `0x${string}`,
          options.payload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);
      }

      if (options.voucher) {
        const accountHex = addressToHex(account.address);
        await validateVoucher(api, accountHex, options.voucher);
      }

      verbose('Creating program...');

      const createResult = api.program.create({
        codeId: codeId as `0x${string}`,
        initPayload: options.payload,
        gasLimit,
        value,
        salt: options.salt as `0x${string}` | undefined,
      }, meta);

      const finalTx = options.voucher
        ? api.voucher.call(options.voucher, { SendMessage: createResult.extrinsic })
        : createResult.extrinsic;

      const txResult = await executeTx(api, finalTx, account);

      output({
        programId: createResult.programId,
        salt: createResult.salt,
        voucherId: options.voucher ?? null,
        txHash: txResult.txHash,
        blockHash: txResult.blockHash,
        blockNumber: txResult.blockNumber,
        events: txResult.events,
      });
    });

  prog
    .command('info')
    .description('Get program information')
    .argument('<programId>', 'program ID (hex or SS58)')
    .action(async (programId: string) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const programIdHex = addressToHex(programId);
      verbose(`Fetching info for program ${programIdHex}`);

      const exists = await api.program.exists(programIdHex);
      if (!exists) {
        throw new CliError(`Program ${programIdHex} not found`, 'PROGRAM_NOT_FOUND');
      }

      const codeId = await api.program.codeId(programIdHex);

      let metaHash: string | null = null;
      try {
        metaHash = await api.program.metaHash(programIdHex);
      } catch {
        // Program may not have metadata
      }

      output({
        programId: programIdHex,
        exists: true,
        codeId,
        metaHash,
      });
    });

  prog
    .command('list')
    .description('List all uploaded programs')
    .option('--count <count>', 'number of programs to list')
    .action(async (options: { count?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose('Fetching program list...');

      const count = options.count ? parseInt(options.count, 10) : undefined;
      const programs = await api.program.allUploadedPrograms(count);

      output(programs);
    });
}
