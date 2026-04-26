import { Command } from 'commander';
import { ProgramMetadata } from '@gear-js/api';
import * as fs from 'fs';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { parseIdlFileAuto } from '../services/sails';
import { executeTx } from '../services/tx-executor';
import { output, verbose, CliError, resolveAmount, addressToHex, coerceArgsAuto, classifyProgramError, loadArgsJson } from '../utils';

export interface InitOptions {
  payload: string;
  idl?: string;
  init?: string;
  args?: string;
  argsFile?: string;
}

/**
 * Resolve the init payload AND the resolved constructor name (for
 * IDL-based encoding) or `null` (for raw `--payload` flows). Used by
 * the dry-run branches so the dry-run JSON can report the actually-
 * selected constructor name when --init was auto-resolved from a
 * single-ctor IDL.
 */
export async function resolveInitDescriptor(options: InitOptions): Promise<{ payload: string; init: string | null }> {
  if (!options.idl) {
    if (options.init) throw new CliError('--init requires --idl', 'MISSING_IDL');
    if (options.args) throw new CliError('--args requires --idl', 'MISSING_IDL');
    if (options.argsFile) throw new CliError('--args-file requires --idl', 'MISSING_IDL');
    return { payload: options.payload, init: null };
  }

  if (options.payload !== '0x') {
    throw new CliError('--payload and --idl are mutually exclusive. Use --idl with --args for Sails encoding, or --payload for raw hex.', 'MUTUALLY_EXCLUSIVE_OPTIONS');
  }

  const sails = await parseIdlFileAuto(options.idl);
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
  if (options.args !== undefined || options.argsFile !== undefined) {
    // Routed through the shared helper: enforces --args / --args-file
    // mutual exclusion, handles stdin via '-', strips file paths from
    // parse-error messages (file may contain test seeds).
    const parsed = loadArgsJson({
      args: options.args,
      argsFile: options.argsFile,
    });
    // Arity-aware top-level JSON validation. 1-arg constructors legitimately
    // accept a bare scalar/object that gets wrapped (preserves the historical
    // struct-config shorthand: `--args '{"admin":"0x..."}'` for `New(cfg: Config)`).
    // For 0-arg or multi-arg constructors, a non-array top-level value is wrong.
    // Type mismatches caught at the codec layer (hex-bytes.ts).
    const arity = ctor.args?.length ?? 0;
    if (!Array.isArray(parsed) && arity !== 1) {
      const got = parsed === null
        ? 'null'
        : typeof parsed === 'object'
          ? 'object'
          : typeof parsed;
      const preview = JSON.stringify(parsed) ?? String(parsed);
      const truncated = preview.length > 100 ? preview.slice(0, 100) + '...' : preview;
      throw new CliError(
        `Constructor "${initName}" expects ${arity} positional arg(s); pass them as a JSON array, e.g. ["0x..."]. ` +
        `Got ${got}: ${truncated}`,
        'INVALID_ARGS_FORMAT',
      );
    }
    args = Array.isArray(parsed) ? parsed : [parsed];
  }

  const expectedArgs = ctor.args?.length ?? 0;
  if (args.length !== expectedArgs) {
    throw new CliError(
      `Constructor "${initName}" expects ${expectedArgs} arg(s), got ${args.length}`,
      'CONSTRUCTOR_ARG_MISMATCH',
    );
  }

  verbose(`Encoding constructor "${initName}" with ${args.length} arg(s)`);
  args = coerceArgsAuto(args, ctor.args || [], sails);
  try {
    return { payload: ctor.encodePayload(...args), init: initName };
  } catch (err) {
    throw new CliError(
      `Failed to encode constructor args: ${err instanceof Error ? err.message : String(err)}`,
      'ENCODE_ERROR',
    );
  }
}

export async function resolveInitPayload(options: InitOptions): Promise<string> {
  return (await resolveInitDescriptor(options)).payload;
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
    .option('--args-file <path>', 'read constructor --args JSON from file (use - for stdin, requires --idl)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--dry-run', 'encode the constructor payload and exit without uploading (no account required)')
    .action(async (wasmPath: string, options: {
      payload: string;
      idl?: string;
      init?: string;
      args?: string;
      argsFile?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
      dryRun?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };

      if (!fs.existsSync(wasmPath)) {
        throw new CliError(`WASM file not found: ${wasmPath}`, 'FILE_NOT_FOUND');
      }

      // Resolve init payload first — it does not need network or an account.
      // This must happen before account resolution so --dry-run works on
      // machines with no wallet configured. resolveInitDescriptor returns
      // the constructor name actually selected (auto or explicit) so the
      // dry-run output reports it accurately.
      const initDesc = await resolveInitDescriptor(options);
      const initPayload = initDesc.payload;

      if (options.dryRun) {
        output({
          kind: 'program-upload',
          init: initDesc.init,
          initPayload,
          value: options.value,
          gasLimit: options.gasLimit ?? null,
          willSubmit: false,
        });
        return;
      }

      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const value = resolveAmount(options.value, options.units);

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
        try {
          const gasInfo = await api.program.calculateGas.initUpload(
            addressToHex(account.address),
            code,
            initPayload,
            value,
            true,
            meta,
          );
          gasLimit = gasInfo.min_limit.toBigInt();
        } catch (err) {
          throw classifyProgramError(err);
        }
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
    .option('--args-file <path>', 'read constructor --args JSON from file (use - for stdin, requires --idl)')
    .option('--gas-limit <gas>', 'gas limit (auto-calculated if not set)')
    .option('--value <value>', 'value to send (in VARA)', '0')
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
    .option('--salt <salt>', 'salt for program address (hex)')
    .option('--metadata <path>', 'path to .meta.txt file')
    .option('--dry-run', 'encode the constructor payload and exit without creating (no account required)')
    .action(async (codeId: string, options: {
      payload: string;
      idl?: string;
      init?: string;
      args?: string;
      argsFile?: string;
      gasLimit?: string;
      value: string;
      units?: string;
      salt?: string;
      metadata?: string;
      dryRun?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };

      // Resolve init payload first — no account or network required, so
      // --dry-run can run on machines with no wallet configured.
      // resolveInitDescriptor returns the resolved constructor name for
      // accurate dry-run reporting (auto-selected or explicit).
      const initDesc = await resolveInitDescriptor(options);
      const initPayload = initDesc.payload;

      if (options.dryRun) {
        output({
          kind: 'program-deploy',
          init: initDesc.init,
          codeId,
          initPayload,
          value: options.value,
          gasLimit: options.gasLimit ?? null,
          willSubmit: false,
        });
        return;
      }

      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const value = resolveAmount(options.value, options.units);

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
        try {
          const gasInfo = await api.program.calculateGas.initCreate(
            addressToHex(account.address),
            codeId as `0x${string}`,
            initPayload,
            value,
            true,
            meta,
          );
          gasLimit = gasInfo.min_limit.toBigInt();
        } catch (err) {
          throw classifyProgramError(err);
        }
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
