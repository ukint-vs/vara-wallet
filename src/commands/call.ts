import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSails, describeSailsProgram } from '../services/sails';
import { output, verbose, CliError, resolveAmount, minimalToVara, addressToHex } from '../utils';

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
    .action(async (programIdArg: string, method: string, options: {
      args: string;
      value: string;
      units?: string;
      gasLimit?: string;
      idl?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const programId = addressToHex(programIdArg);

      // Parse Service/Method
      const parts = method.split('/');
      if (parts.length !== 2) {
        throw new CliError(
          `Method must be in "Service/Method" format (e.g. Counter/Increment). Got: "${method}"`,
          'INVALID_METHOD_FORMAT',
        );
      }
      const [serviceName, methodName] = parts;

      // Load Sails
      const sails = await loadSails(api, { programId, idl: options.idl });

      // Find the service
      const service = sails.services[serviceName];
      if (!service) {
        const available = Object.keys(sails.services).join(', ');
        throw new CliError(
          `Service "${serviceName}" not found. Available services: ${available}`,
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
        throw new CliError(
          `Method "${methodName}" not found in service "${serviceName}". Available: ${allMethods.join(', ')}`,
          'METHOD_NOT_FOUND',
        );
      }

      if (isQuery) {
        await executeQuery(api, sails, serviceName, methodName, args, opts);
      } else {
        await executeFunction(api, sails, serviceName, methodName, args, options, opts);
      }
    });
}

async function executeQuery(
  _api: unknown,
  sails: import('sails-js').Sails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  opts: AccountOptions & { ws?: string },
): Promise<void> {
  verbose(`Executing query: ${serviceName}/${methodName}`);

  const query = sails.services[serviceName].queries[methodName];
  const queryBuilder = query(...args);

  // Set origin address if available
  try {
    const address = await resolveAddress(undefined, opts);
    queryBuilder.withAddress(address);
  } catch {
    // Use default zero address if no account configured
  }

  const result = await queryBuilder.call();

  output({ result });
}

async function executeFunction(
  api: import('@gear-js/api').GearApi,
  sails: import('sails-js').Sails,
  serviceName: string,
  methodName: string,
  args: unknown[],
  options: { value: string; units?: string; gasLimit?: string },
  opts: AccountOptions & { ws?: string },
): Promise<void> {
  verbose(`Executing function: ${serviceName}/${methodName}`);

  const account = await resolveAccount(opts);
  const isRaw = options.units === 'raw';
  const value = resolveAmount(options.value, isRaw);

  const func = sails.services[serviceName].functions[methodName];
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

  const result = await txBuilder.signAndSend();
  const response = await result.response();

  output({
    txHash: result.txHash,
    blockHash: result.blockHash,
    messageId: result.msgId,
    result: response,
  });
}
