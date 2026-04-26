import { Command } from 'commander';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSailsAuto, describeSailsProgram, suggestMethod, suggestService, type LoadedSails } from '../services/sails';
import { collectDecodedEvents } from '../services/sails-events';
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
    .option('--units <units>', 'amount units: human (default, = VARA) or raw')
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

      // --estimate and --dry-run COMPOSE on functions: when both are set,
      // we encode the payload AND compute gas estimate (requires account).
      // The legacy mutex was overly restrictive; previewing both is the
      // common case for "what will this cost AND what payload am I sending".

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
      // Reject non-array top-level JSON. Without this guard, a user passing
      // `--args '{"address":"0x..."}'` would get the value silently wrapped
      // as `[{"address":"0x..."}]` and downstream codecs would emit a cryptic
      // "Expected 32 bytes, found 15 bytes" once the object hit the ActorId
      // path. Sails methods take POSITIONAL args; named-arg objects are
      // never the right shape.
      if (!Array.isArray(parsed)) {
        const got = parsed === null
          ? 'null'
          : typeof parsed === 'object'
            ? 'object'
            : typeof parsed;
        const preview = JSON.stringify(parsed) ?? String(parsed);
        const truncated = preview.length > 100 ? preview.slice(0, 100) + '...' : preview;
        throw new CliError(
          `Args must be a JSON array of positional values, e.g. ["0x..."]. ` +
          `Got ${got}: ${truncated}`,
          'INVALID_ARGS_FORMAT',
        );
      }
      let args: unknown[] = parsed;

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
 * Resolve the dry-run payload + destination for a function call.
 *
 * `encodedPayload` MUST come from `func.encodePayload(...args)` — the
 * canonical SCALE encoder. `txBuilder.payload` (sails-js's
 * `this._tx.args[0].toHex()`) is the message destination program ID,
 * not the encoded call. Surfacing both pieces from one helper makes the
 * contract testable: a regression that swapped `encodedPayload` to
 * `txBuilder.payload` would visibly disagree with `destination` in
 * tests, where the production code did silently the wrong thing.
 *
 * Takes `txBuilder` as a separate arg (instead of building one
 * internally) so the action handler doesn't double-build txBuilder
 * when it also needs gas-calc / signAndSend on the same instance.
 *
 * Exported with the `_…ForTests` suffix to match the convention used by
 * `_tryExtractFromChainForTests` and `_resolveIdlForTests` in
 * `src/services/sails.ts` — public surface is reserved for the action
 * handler, this is purely a regression-test seam.
 */
export function _resolveDryRunPayloadForTests(
  func: { encodePayload: (...args: unknown[]) => string },
  txBuilder: { programId: string },
  args: unknown[],
): { encodedPayload: string; destination: string } {
  return {
    encodedPayload: func.encodePayload(...args),
    destination: txBuilder.programId,
  };
}

/**
 * Build the dry-run output object for a function call.
 * Pure helper so it can be unit-tested without wiring the full Commander
 * action. Key order is fixed for deterministic agent-friendly output.
 *
 * `destination` is the program ID the message is bound for. Surfaced
 * separately from `encodedPayload` (the SCALE-encoded call) so callers
 * can identify both pieces from a single dry-run reply.
 *
 * `estimateGas`, when present, is the result of composing --dry-run with
 * --estimate (requires an account). Absent on plain --dry-run.
 */
export function buildFunctionDryRun(input: {
  service: string;
  method: string;
  args: unknown[];
  encodedPayload: string;
  destination: string;
  value?: string;
  gasLimit?: string;
  voucherId?: string;
  estimateGas?: { gasLimit: string | null; minLimit: string | null };
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: 'function',
    service: input.service,
    method: input.method,
    args: input.args,
    encodedPayload: input.encodedPayload,
    destination: input.destination,
    value: input.value ?? '0',
    gasLimit: input.gasLimit ?? null,
    voucherId: input.voucherId ?? null,
  };
  if (input.estimateGas) {
    out.estimateGas = input.estimateGas;
  }
  out.willSubmit = false;
  return out;
}

/**
 * Build the dry-run output object for a query call.
 *
 * Queries do not have a `destination` field today because the on-chain
 * query path does not surface one separately from the program ID supplied
 * by the caller. Add if a use case emerges.
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

  // Dry-run + estimate composition. Both are read-only previews:
  //   --dry-run      : encode payload, no account needed.
  //   --estimate     : compute gas, account required.
  //   both together  : encode payload AND compute gas, account required.
  //   neither        : real submission (further down).
  //
  // _resolveDryRunPayloadForTests is the canonical encoder seam (also
  // exported as a regression hook). The dry-run+estimate path falls
  // through to gas calc, which mutates txBuilder via
  // withAccount/withValue/calculateGas — same instance, no rebuild.
  const txBuilder = func(...args);
  const { encodedPayload, destination } = _resolveDryRunPayloadForTests(func, txBuilder, args);

  if (options.dryRun && !options.estimate) {
    output(buildFunctionDryRun({
      service: serviceName,
      method: methodName,
      args,
      encodedPayload,
      destination,
      value: options.value !== '0' ? options.value : undefined,
      gasLimit: options.gasLimit,
      voucherId: options.voucher,
    }));
    return;
  }

  const account = await resolveAccount(opts);
  const value = resolveAmount(options.value, options.units);

  if (options.voucher) {
    const accountHex = addressToHex(account.address);
    await validateVoucher(api, accountHex, options.voucher, programId);
  }

  txBuilder.withAccount(account);

  if (value > 0n) {
    txBuilder.withValue(value);
  }

  if (options.gasLimit) {
    txBuilder.withGas(BigInt(options.gasLimit));
  } else {
    verbose('Calculating gas...');
    try {
      await txBuilder.calculateGas();
    } catch (err) {
      throw classifyProgramError(err);
    }
    verbose(`Gas: ${txBuilder.gasInfo?.min_limit?.toString() || 'calculated'}`);
  }

  if (options.estimate) {
    const gasLimitStr = (txBuilder.gasInfo as any)?.limit?.toString() ?? txBuilder.gasInfo?.min_limit?.toString() ?? null;
    const minLimitStr = txBuilder.gasInfo?.min_limit?.toString() ?? null;

    if (options.dryRun) {
      // Composition: dry-run shape with estimateGas appended.
      output(buildFunctionDryRun({
        service: serviceName,
        method: methodName,
        args,
        encodedPayload,
        destination,
        value: options.value !== '0' ? options.value : undefined,
        gasLimit: options.gasLimit,
        voucherId: options.voucher,
        estimateGas: { gasLimit: gasLimitStr, minLimit: minLimitStr },
      }));
    } else {
      // Pure --estimate (no --dry-run): preserve the legacy lean shape so
      // existing scripts parsing { estimate: true, gasLimit, minLimit, value }
      // keep working unchanged.
      output({
        estimate: true,
        gasLimit: gasLimitStr,
        minLimit: minLimitStr,
        value: value.toString(),
      });
    }
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

  // Phase-correlated block-event scan (#37). Walks system.events() at the
  // inclusion block, restricting to records emitted by OUR extrinsic
  // (via phase index match) and our programId, then runs each through
  // decodeSailsEvent. Always-on, additive — `events` is a new key, never
  // replaces or renames anything in the existing reply shape.
  // sails-js `IMethodReturnType` declares blockHash/txHash as `HexString`
  // (= `0x${string}`) and the runtime (`transaction-builder.js`) returns them
  // already converted via `.toHex()`. No cast needed; pass straight through.
  const programIdHex = addressToHex(programId);
  const events = await collectDecodedEvents(
    api,
    sails,
    result.blockHash,
    result.txHash,
    programIdHex,
  );

  output({
    txHash: result.txHash,
    blockHash: result.blockHash,
    blockNumber,
    messageId: result.msgId,
    voucherId: options.voucher ?? null,
    result: decoded,
    events,
  });
}
