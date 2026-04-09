import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { parseIdlFile } from '../services/sails';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError, resolveAmount, addressToHex, coerceArgs } from '../utils';

export interface InitOptions {
  payload: string;
  idl?: string;
  init?: string;
  args?: string;
}

export async function resolveInitPayload(options: InitOptions): Promise<string> {
  if (!options.idl) {
    if (options.init) throw new CliError('--init requires --idl', 'MISSING_IDL');
    if (options.args) throw new CliError('--args requires --idl', 'MISSING_IDL');
    return options.payload;
  }

  if (options.payload !== '0x') {
    throw new CliError('--payload and --idl are mutually exclusive. Use --idl with --args for Sails encoding, or --payload for raw hex.', 'MUTUALLY_EXCLUSIVE_OPTIONS');
  }

  const sails = await parseIdlFile(options.idl);
  const ctors = sails.ctors;
  if (!ctors || Object.keys(ctors).length === 0) {
    throw new CliError('IDL has no constructors defined', 'NO_CONSTRUCTORS');
  }

  const ctorNames = Object.keys(ctors);
  let initName = options.init;
  if (!initName) {
    if (ctorNames.length === 1) {
      initName = ctorNames[0];
      verbose(`Auto-selected constructor: ${initName}`);
    } else {
      throw new CliError(
        `Multiple constructors found: ${ctorNames.join(', ')}. Use --init <name> to select one.`,
        'MULTIPLE_CONSTRUCTORS',
      );
    }
  }

  const ctor = ctors[initName];
  if (!ctor) {
    throw new CliError(
      `Constructor "${initName}" not found. Available: ${ctorNames.join(', ')}`,
      'CONSTRUCTOR_NOT_FOUND',
    );
  }

  let args: unknown[] = [];
  if (options.args) {
    try {
      const parsed = JSON.parse(options.args);
      args = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new CliError(`Invalid JSON in --args: ${options.args}`, 'INVALID_ARGS');
    }
  }

  const expectedArgs = ctor.args?.length ?? 0;
  if (args.length !== expectedArgs) {
    throw new CliError(
      `Constructor "${initName}" expects ${expectedArgs} arg(s), got ${args.length}`,
      'CONSTRUCTOR_ARG_MISMATCH',
    );
  }

  verbose(`Encoding constructor "${initName}" with ${args.length} arg(s)`);
  args = coerceArgs(args, ctor.args || [], sails);
  try {
    return ctor.encodePayload(...args);
  } catch (err) {
    throw new CliError(
      `Failed to encode constructor args: ${err instanceof Error ? err.message : String(err)}`,
      'ENCODE_ERROR',
    );
  }
}

export function registerProgramCommand(program: Command): void {
  const prog = program.command('program').description('Program operations');

  prog
    .command('upload')
    .description('Upload a program from WASM file. For Sails programs, use --idl with --init and --args to auto-encode the constructor payload')
    .argument('<wasm>', 'path to .wasm file')
    .option('--payload <payload>', 'init payload (hex or JSON)', '0x')
    .option('--idl <path>', 'path to Sails IDL file (auto-encodes constructor payload)')
    .option('--init <name>', 'constructor name (auto-selected if IDL has only one)')
    .option('--args <json>', 'constructor arguments as JSON array (requires --idl)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .action(async (wasmPath: string, options: {
      payload: string;
      idl?: string;
      init?: string;
      args?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
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
      const initPayload = await resolveInitPayload(options);

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
          initPayload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);
      }

      verbose('Uploading program...');

      const uploadResult = api.program.upload({
        code,
        initPayload,
        gasLimit,
        value,
        salt: options.salt as `0x${string}` | undefined,
      }, meta);

      const txResult = await executeTx(api, uploadResult.extrinsic, account);

      output({
        programId: uploadResult.programId,
        codeId: uploadResult.codeId,
        salt: uploadResult.salt,
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
    .option('--idl <path>', 'path to Sails IDL file (auto-encodes constructor payload)')
    .option('--init <name>', 'constructor name (auto-selected if IDL has only one)')
    .option('--args <json>', 'constructor arguments as JSON array (requires --idl)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .action(async (codeId: string, options: {
      payload: string;
      idl?: string;
      init?: string;
      args?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const isRaw = options.units === 'raw';
      const value = resolveAmount(options.value, isRaw);

      const initPayload = await resolveInitPayload(options);

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
          initPayload,
          value,
          true,
          meta,
        );
        gasLimit = gasInfo.min_limit.toBigInt();
        verbose(`Gas limit: ${gasLimit}`);
      }

      verbose('Creating program...');

      const createResult = api.program.create({
        codeId: codeId as `0x${string}`,
        initPayload,
        gasLimit,
        value,
        salt: options.salt as `0x${string}` | undefined,
      }, meta);

      const txResult = await executeTx(api, createResult.extrinsic, account);

      output({
        programId: createResult.programId,
        salt: createResult.salt,
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
    .option('--count <count>', 'number of programs to list (default: 100)')
    .option('--all', 'list all programs without limit')
    .action(async (options: { count?: string; all?: boolean }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      verbose('Fetching program list...');

      const count = options.all ? undefined : (options.count ? parseInt(options.count, 10) : 100);
      const programs = await api.program.allUploadedPrograms(count);

      output(programs);
    });
}
