import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSailsAuto, describeSailsProgram, suggestMethod, suggestService, type LoadedSails } from '../services/sails';
import { resolveBlockNumber } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex, coerceArgsAuto, decodeSailsResult, classifyProgramError, loadArgsJson } from '../utils';

export function registerCallCommand(program: Command): void {
  program
    .command('call')
    .description('Call a Sails program method (auto-detects query vs function)')
    .argument('<programId>', 'program ID (hex or SS58)')
    .argument('<method>', 'Service/Method name (e.g. Counter/Increment)')
    .option('--args <json>', 'method arguments as JSON array (default: [])')
    .option('--args-file <path>', 'read --args JSON from file (use - for stdin)')
    .option('--value <value>', 'value to send (in VARA, functions only)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--gas-limit <gas>', 'gas limit override (functions only)')
    .option('--idl <path>', 'path to local IDL file')
    .option('--voucher <id>', 'voucher ID to pay for the message')
    .option('--estimate', 'estimate gas cost without sending (requires account)')
    .option('--dry-run', 'encode the payload and exit without signing or submitting (no account required)')
    .action(async (programId: string, method: string, options: {
      args?: string;
      argsFile?: string;
      value: string;
      units?: string;
      gasLimit?: string;
      idl?: string;
      voucher?: string;
      estimate?: boolean;
      dryRun?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };

      // Mutual exclusion: --estimate and --dry-run are both "preview" modes;
      // picking one is unambiguous. Surface explicitly.
      if (options.estimate && options.dryRun) {
        throw new CliError(
          'Cannot use --estimate and --dry-run together; pick one.',
          'CONFLICTING_OPTIONS',
        );
      }

      const api = await getApi(opts.ws);

      // Parse Service/Method
      const parts = method.split('/');
      if (parts.length !== 2) {
        throw new CliError(
          `Method must be in "Service/Method" format (e.g. Counter/Increment). Got: "${method}"`,
          'INVALID_METHOD_FORMAT',
        );
      }
      const [serviceName, methodName] = parts;

      // Load Sails (auto-detects v1 vs v2 IDL)
      const sails = await loadSailsAuto(api, { programId, idl: options.idl });

      // Find the service
      const service = sails.services[serviceName];
      if (!service) {
        const available = Object.keys(sails.services).join(', ');
        const hint = suggestService(sails, serviceName);
        const prefix = hint ? `Did you mean: ${hint}/${methodName}? ` : '';
        throw new CliError(
          `${prefix}Service "${serviceName}" not found. Available services: ${available}`,
          'SERVICE_NOT_FOUND',
        );
      }

      // Resolve args from --args, --args-file, or default '[]'.
      // loadArgsJson enforces mutual exclusion and the privacy contract
      // around malformed-JSON errors (no path leakage).
      const parsed = loadArgsJson({
        args: options.args,
        argsFile: options.argsFile,
        argsDefault: '[]',
      });
      let args: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

      // Check if it's a query or function
      const isQuery = methodName in service.queries;
      const isFunction = methodName in service.functions;

      if (!isQuery && !isFunction) {
        const description = describeSailsProgram(sails);
        const serviceDesc = description[serviceName] as Record<string, Record<string, unknown>>;
        const allMethods = [
          ...Object.keys(serviceDesc.functions || {}).map((m) => `${serviceName}/${m} (function)`),
          ...Object.keys(serviceDesc.queries || {}).map((m) => `${serviceName}/${m} (query)`),
        ];
        const hint = suggestMethod(sails, serviceName, methodName);
        const prefix = hint ? `Did you mean: ${hint}? ` : '';
        throw new CliError(
          `${prefix}Method "${methodName}" not found in service "${serviceName}". Available: ${allMethods.join(', ')}`,
          'METHOD_NOT_FOUND',
        );
      }

      if (isQuery) {
        if (options.voucher) {
          throw new CliError(
            '--voucher cannot be used with query methods',
            'VOUCHER_ON_QUERY',
          );
        }
        await executeQuery(api, sails, serviceName, methodName, args, opts, !!options.dryRun);
      } else {
        await executeFunction(api, sails, serviceName, methodName, args, options, opts, programId);
      }
    });
}

/**
 * Build the dry-run output object for a function call.
 * Pure helper so it can be unit-tested without wiring the full Commander
 * action. Key order is fixed for deterministic agent-friendly output.
 */
export function buildFunctionDryRun(input: {
  service: string;
  method: string;
  args: unknown[];
  encodedPayload: string;
  value?: string;
  gasLimit?: string;
  voucherId?: string;
}): Record<string, unknown> {
  return {
    kind: 'function',
    service: input.service,
    method: input.method,
    args: input.args,
    encodedPayload: input.encodedPayload,
    value: input.value ?? '0',
    gasLimit: input.gasLimit ?? null,
    voucherId: input.voucherId ?? null,
    willSubmit: false,
  };
}

/**
 * Build the dry-run output object for a query call.
 */
export function buildQueryDryRun(input: {
  service: string;
  method: string;
  args: unknown[];
  encodedPayload: string;
}): Record<string, unknown> {
  return {
    kind: 'query',
    service: input.service,
    method: input.method,
    args: input.args,
    encodedPayload: input.encodedPayload,
    willSubmit: false,
  };
}

async function executeQuery(
  _api: unknown,
  sails: LoadedSails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  opts: AccountOptions & { ws?: string },
  dryRun: boolean,
): Promise<void> {
  verbose(`Executing query: ${serviceName}/${methodName}`);

  const query = sails.services[serviceName].queries[methodName];
  args = coerceArgsAuto(args, query.args, sails, serviceName);

  if (dryRun) {
    const encodedPayload = query.encodePayload(...args);
    output(buildQueryDryRun({
      service: serviceName,
      method: methodName,
      args,
      encodedPayload,
    }));
    return;
  }

  const queryBuilder = query(...args);

  // Set origin address if available
  try {
    const address = await resolveAddress(undefined, opts);
    queryBuilder.withAddress(address);
  } catch {
    // Use default zero address if no account configured
  }

  let raw;
  try {
    raw = await queryBuilder.call();
  } catch (err) {
    throw classifyProgramError(err);
  }
  const result = decodeSailsResult(sails, query.returnTypeDef, raw, serviceName);

  output({ result });
}

async function executeFunction(
  api: import('@gear-js/api').GearApi,
  sails: LoadedSails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  options: { value: string; units?: string; gasLimit?: string; voucher?: string; estimate?: boolean; dryRun?: boolean },
  opts: AccountOptions & { ws?: string },
  programId: string,
): Promise<void> {
  verbose(`Executing function: ${serviceName}/${methodName}`);

  const func = sails.services[serviceName].functions[methodName];
  args = coerceArgsAuto(args, func.args, sails, serviceName);

  // Dry-run: encode payload and exit. No account, no gas calc, no submit.
  // This must run BEFORE any account / value resolution so agents on
  // machines with no wallet configured can still preview a payload.
  if (options.dryRun) {
    const txBuilder = func(...args);
    const encodedPayload = txBuilder.payload;
    output(buildFunctionDryRun({
      service: serviceName,
      method: methodName,
      args,
      encodedPayload,
      value: options.value !== '0' ? options.value : undefined,
      gasLimit: options.gasLimit,
      voucherId: options.voucher,
    }));
    return;
  }

  const account = await resolveAccount(opts);
  const isRaw = options.units === 'raw';
  const value = resolveAmount(options.value, isRaw);

  if (options.voucher) {
    const accountHex = addressToHex(account.address);
    await validateVoucher(api, accountHex, options.voucher, programId);
  }

  const txBuilder = func(...args);

  txBuilder.withAccount(account);

  if (value > 0n) {
    txBuilder.withValue(value);
  }

  if (options.gasLimit) {
    txBuilder.withGas(BigInt(options.gasLimit));
  } else {
    verbose('Calculating gas...');
    await txBuilder.calculateGas();
    verbose(`Gas: ${txBuilder.gasInfo?.min_limit?.toString() || 'calculated'}`);
  }

  if (options.estimate) {
    output({
      estimate: true,
      gasLimit: (txBuilder.gasInfo as any)?.limit?.toString() ?? txBuilder.gasInfo?.min_limit?.toString() ?? null,
      minLimit: txBuilder.gasInfo?.min_limit?.toString() ?? null,
      value: value.toString(),
    });
    return;
  }

  if (options.voucher) {
    txBuilder.withVoucher(options.voucher as `0x${string}`);
  }

  const result = await txBuilder.signAndSend();
  let response;
  try {
    response = await result.response();
  } catch (err) {
    throw classifyProgramError(err);
  }
  const blockNumber = await resolveBlockNumber(api, result.blockHash);

  const decoded = decodeSailsResult(sails, func.returnTypeDef, response, serviceName);

  output({
    txHash: result.txHash,
    blockHash: result.blockHash,
    blockNumber,
    messageId: result.msgId,
    voucherId: options.voucher ?? null,
    result: decoded,
  });
}
