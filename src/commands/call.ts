import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSailsAuto, describeSailsProgram, suggestMethod, suggestService, type LoadedSails } from '../services/sails';
import { resolveBlockNumber } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex, coerceArgsAuto, decodeSailsResult } from '../utils';

export function registerCallCommand(program: Command): void {
  program
    .command('call')
    .description('Call a Sails program method (auto-detects query vs function)')
    .argument('<programId>', 'program ID (hex or SS58)')
    .argument('<method>', 'Service/Method name (e.g. Counter/Increment)')
    .option('--args <json>', 'method arguments as JSON array', '[]')
    .option('--value <value>', 'value to send (in VARA, functions only)', '0')
    .option('--units <units>', 'amount units: vara (default) or raw')
    .option('--gas-limit <gas>', 'gas limit override (functions only)')
    .option('--idl <path>', 'path to local IDL file')
    .option('--voucher <id>', 'voucher ID to pay for the message')
    .option('--estimate', 'estimate gas cost without sending (requires account)')
    .action(async (programId: string, method: string, options: {
      args: string;
      value: string;
      units?: string;
      gasLimit?: string;
      idl?: string;
      voucher?: string;
      estimate?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
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

      // Parse args
      let args: unknown[];
      try {
        const parsed = JSON.parse(options.args);
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new CliError(
          `Invalid JSON args: ${options.args}`,
          'INVALID_ARGS',
        );
      }

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
        await executeQuery(api, sails, serviceName, methodName, args, opts);
      } else {
        await executeFunction(api, sails, serviceName, methodName, args, options, opts, programId);
      }
    });
}

async function executeQuery(
  _api: unknown,
  sails: LoadedSails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  opts: AccountOptions & { ws?: string },
): Promise<void> {
  verbose(`Executing query: ${serviceName}/${methodName}`);

  const query = sails.services[serviceName].queries[methodName];
  args = coerceArgsAuto(args, query.args, sails, serviceName);
  const queryBuilder = query(...args);

  // Set origin address if available
  try {
    const address = await resolveAddress(undefined, opts);
    queryBuilder.withAddress(address);
  } catch {
    // Use default zero address if no account configured
  }

  const raw = await queryBuilder.call();
  const result = decodeSailsResult(sails, query.returnTypeDef, raw, serviceName);

  output({ result });
}

async function executeFunction(
  api: import('@gear-js/api').GearApi,
  sails: LoadedSails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  options: { value: string; units?: string; gasLimit?: string; voucher?: string; estimate?: boolean },
  opts: AccountOptions & { ws?: string },
  programId: string,
): Promise<void> {
  verbose(`Executing function: ${serviceName}/${methodName}`);

  const account = await resolveAccount(opts);
  const isRaw = options.units === 'raw';
  const value = resolveAmount(options.value, isRaw);

  if (options.voucher) {
    const accountHex = addressToHex(account.address);
    await validateVoucher(api, accountHex, options.voucher, programId);
  }

  const func = sails.services[serviceName].functions[methodName];
  args = coerceArgsAuto(args, func.args, sails, serviceName);
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
    const msg = err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null
        ? JSON.stringify(err)
        : String(err);
    throw new CliError(`Program execution failed: ${msg}`, 'PROGRAM_ERROR');
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
