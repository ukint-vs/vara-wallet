import { Command } from 'commander';
import { Sails } from 'sails-js';
import { GearApi } from '@gear-js/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { loadSails } from '../services/sails';
import { resolveBlockNumber } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, minimalToVara, toMinimalUnits, addressToHex, decodeSailsResult } from '../utils';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Find the service that contains the given method (query or function).
 * VFT programs may name their service differently (Vft, Service, Token, etc.)
 */
function findVftService(sails: Sails, methodName: string): string {
  for (const [serviceName, service] of Object.entries(sails.services)) {
    if (methodName in service.queries || methodName in service.functions) {
      return serviceName;
    }
  }

  const available = Object.keys(sails.services).join(', ');
  throw new CliError(
    `No service with method "${methodName}" found. Available services: ${available}`,
    'VFT_SERVICE_NOT_FOUND',
  );
}

/**
 * Build an idlValidator callback for use with loadSails.
 * Returns true if the given method exists in any service.
 */
function makeVftValidator(methodName: string): (sails: Sails) => boolean {
  return (sails: Sails) => {
    for (const service of Object.values(sails.services)) {
      if (methodName in service.queries || methodName in service.functions) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Query token decimals from the program. Returns null if unavailable.
 */
async function queryDecimals(sails: Sails, serviceName: string): Promise<number | null> {
  try {
    const decQuery = sails.services[serviceName].queries['Decimals'];
    if (decQuery) {
      const dec = await decQuery().call();
      return Number(dec);
    }
  } catch {
    // Decimals may not exist on the same service; search all services
  }

  // Try other services (e.g. VftMetadata)
  for (const [name, service] of Object.entries(sails.services)) {
    if (name === serviceName) continue;
    try {
      const decQuery = service.queries['Decimals'];
      if (decQuery) {
        const dec = await decQuery().call();
        return Number(dec);
      }
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Resolve an amount for a VFT transaction.
 *
 * Vocabulary (unified in 0.15.0):
 *   - `human` : query the token's decimals via the IDL and convert.
 *               Hard-fails if decimals query is unavailable.
 *   - `raw`   : default — pass through as BigInt (minimal units).
 *
 * Anything else is INVALID_UNITS. The legacy `token` literal (0.14.x) is
 * intentionally rejected — `human` is the unified vocabulary across all
 * commands; for VFT it means "use the token's declared decimals".
 */
async function resolveVftAmount(
  sails: Sails,
  serviceName: string,
  amount: string,
  units?: string,
): Promise<bigint> {
  if (units !== undefined && units !== 'raw' && units !== 'human') {
    throw new CliError(
      `Invalid --units value: "${units}". Must be "raw" or "human".`,
      'INVALID_UNITS',
    );
  }

  if (units === 'human') {
    const decimals = await queryDecimals(sails, serviceName);
    if (decimals === null) {
      throw new CliError(
        'Cannot use --units human: Decimals query is not available on this token program.',
        'DECIMALS_UNAVAILABLE',
      );
    }
    verbose(`Converting ${amount} tokens using ${decimals} decimals`);
    try {
      return toMinimalUnits(amount, decimals);
    } catch (err) {
      throw new CliError(
        err instanceof Error ? err.message : String(err),
        'INVALID_AMOUNT',
      );
    }
  }

  try {
    return BigInt(amount);
  } catch {
    throw new CliError(
      `Invalid amount: "${amount}". Use a whole number for raw units, or --units human for decimal amounts.`,
      'INVALID_AMOUNT',
    );
  }
}

/**
 * Shared transaction execution for VFT commands.
 */
async function executeVftTx(
  api: GearApi,
  sails: Sails,
  serviceName: string,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  account: KeyringPair,
  voucher?: string,
  programId?: string,
): Promise<void> {
  if (voucher) {
    const accountHex = addressToHex(account.address);
    await validateVoucher(api, accountHex, voucher, programId);
  }

  const func = sails.services[serviceName].functions[methodName];
  const txBuilder = func(...args);

  txBuilder.withAccount(account);
  await txBuilder.calculateGas();

  if (voucher) {
    txBuilder.withVoucher(voucher as `0x${string}`);
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
    voucherId: voucher ?? null,
    result: decoded,
  });
}

/**
 * Try to query a single field from any service. Returns null on failure.
 */
async function queryTokenField(sails: Sails, fieldName: string): Promise<unknown | null> {
  for (const service of Object.values(sails.services)) {
    try {
      const query = service.queries[fieldName];
      if (query) {
        return await query().call();
      }
    } catch {
      // continue to next service
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

interface VftTxOptions {
  idl?: string;
  units?: string;
  voucher?: string;
}

export function registerVftCommand(program: Command): void {
  const vft = program.command('vft').description('VFT (fungible token) operations');

  // ── vft info ──────────────────────────────────────────────────────────
  vft
    .command('info')
    .description('Query VFT token info (name, symbol, decimals, total supply)')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('BalanceOf'),
      });

      verbose(`Querying VFT info for ${tokenProgram}`);

      const fields = ['Name', 'Symbol', 'Decimals', 'TotalSupply'] as const;
      const results: Record<string, unknown> = {};

      for (const service of Object.values(sails.services)) {
        const pending: Array<{ field: string; promise: Promise<unknown> }> = [];
        for (const field of fields) {
          if (!(field in results) && service.queries[field]) {
            pending.push({ field, promise: service.queries[field]().call() });
          }
        }
        if (pending.length > 0) {
          const settled = await Promise.allSettled(pending.map((p) => p.promise));
          for (let i = 0; i < pending.length; i++) {
            if (settled[i].status === 'fulfilled') {
              results[pending[i].field] = (settled[i] as PromiseFulfilledResult<unknown>).value;
            }
          }
        }
        if (fields.every((f) => f in results)) break;
      }

      const [name, symbol, decimals, totalSupply] = fields.map((f) => results[f] ?? null);

      const dec = decimals !== null ? Number(decimals) : null;

      output({
        tokenProgram,
        name: name !== null ? String(name) : null,
        symbol: symbol !== null ? String(symbol) : null,
        decimals: dec,
        totalSupply: totalSupply !== null ? String(totalSupply) : null,
        totalSupplyFormatted:
          totalSupply !== null && dec !== null
            ? minimalToVara(BigInt(totalSupply as string | number | bigint), dec)
            : null,
      });
    });

  // ── vft balance ───────────────────────────────────────────────────────
  vft
    .command('balance')
    .description('Query VFT token balance')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('[account]', 'account address to query (defaults to configured account)')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, account: string | undefined, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const address = await resolveAddress(account, opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('BalanceOf'),
      });

      const serviceName = findVftService(sails, 'BalanceOf');

      verbose(`Querying VFT balance for ${address} on ${tokenProgram}`);

      const query = sails.services[serviceName].queries['BalanceOf'];
      const result = await query(address).call();

      const decimals = await queryDecimals(sails, serviceName);

      output({
        tokenProgram,
        account: address,
        balance: decimals !== null
          ? minimalToVara(BigInt(result), decimals)
          : String(result),
        balanceRaw: String(result),
        ...(decimals !== null && { decimals }),
      });
    });

  // ── vft allowance ─────────────────────────────────────────────────────
  vft
    .command('allowance')
    .description('Query VFT token allowance')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<owner>', 'token owner address')
    .argument('<spender>', 'spender address')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (tokenProgram: string, owner: string, spender: string, options: { idl?: string }) => {
      const opts = program.optsWithGlobals() as { ws?: string };
      const api = await getApi(opts.ws);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('Allowance'),
      });

      const serviceName = findVftService(sails, 'Allowance');

      verbose(`Querying allowance for owner=${owner} spender=${spender} on ${tokenProgram}`);

      const query = sails.services[serviceName].queries['Allowance'];
      const result = await query(owner, spender).call();

      const decimals = await queryDecimals(sails, serviceName);

      output({
        tokenProgram,
        owner,
        spender,
        allowance: decimals !== null
          ? minimalToVara(BigInt(result), decimals)
          : String(result),
        allowanceRaw: String(result),
        ...(decimals !== null && { decimals }),
      });
    });

  // ── vft transfer ──────────────────────────────────────────────────────
  vft
    .command('transfer')
    .description('Transfer VFT tokens')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<to>', 'destination address')
    .argument('<amount>', 'amount to transfer')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or human (uses token decimals)', undefined)
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (tokenProgram: string, to: string, amount: string, options: VftTxOptions) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('Transfer'),
      });
      const serviceName = findVftService(sails, 'Transfer');
      const resolvedAmount = await resolveVftAmount(sails, serviceName, amount, options.units);

      verbose(`Transferring ${resolvedAmount} tokens to ${to}`);
      await executeVftTx(api, sails, serviceName, 'Transfer', [to, resolvedAmount], account, options.voucher, tokenProgram);
    });

  // ── vft approve ───────────────────────────────────────────────────────
  vft
    .command('approve')
    .description('Approve VFT token spending')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<spender>', 'spender address')
    .argument('<amount>', 'amount to approve')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or human (uses token decimals)', undefined)
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (tokenProgram: string, spender: string, amount: string, options: VftTxOptions) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('Approve'),
      });
      const serviceName = findVftService(sails, 'Approve');
      const resolvedAmount = await resolveVftAmount(sails, serviceName, amount, options.units);

      verbose(`Approving ${resolvedAmount} tokens for ${spender}`);
      await executeVftTx(api, sails, serviceName, 'Approve', [spender, resolvedAmount], account, options.voucher, tokenProgram);
    });

  // ── vft transfer-from ─────────────────────────────────────────────────
  vft
    .command('transfer-from')
    .description('Transfer VFT tokens from another account (requires prior approval)')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<from>', 'source address')
    .argument('<to>', 'destination address')
    .argument('<amount>', 'amount to transfer')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or human (uses token decimals)', undefined)
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (tokenProgram: string, from: string, to: string, amount: string, options: VftTxOptions) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('TransferFrom'),
      });
      const serviceName = findVftService(sails, 'TransferFrom');
      const resolvedAmount = await resolveVftAmount(sails, serviceName, amount, options.units);

      verbose(`Transferring ${resolvedAmount} tokens from ${from} to ${to}`);
      await executeVftTx(api, sails, serviceName, 'TransferFrom', [from, to, resolvedAmount], account, options.voucher, tokenProgram);
    });

  // ── vft mint ──────────────────────────────────────────────────────────
  vft
    .command('mint')
    .description('Mint VFT tokens (admin only)')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<to>', 'recipient address')
    .argument('<amount>', 'amount to mint')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or human (uses token decimals)', undefined)
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (tokenProgram: string, to: string, amount: string, options: VftTxOptions) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('Mint'),
      });
      const serviceName = findVftService(sails, 'Mint');
      const resolvedAmount = await resolveVftAmount(sails, serviceName, amount, options.units);

      verbose(`Minting ${resolvedAmount} tokens to ${to}`);
      await executeVftTx(api, sails, serviceName, 'Mint', [to, resolvedAmount], account, options.voucher, tokenProgram);
    });

  // ── vft burn ──────────────────────────────────────────────────────────
  vft
    .command('burn')
    .description('Burn VFT tokens (admin only)')
    .argument('<tokenProgram>', 'VFT program ID (0x...)')
    .argument('<from>', 'address to burn from')
    .argument('<amount>', 'amount to burn')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or human (uses token decimals)', undefined)
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (tokenProgram: string, from: string, amount: string, options: VftTxOptions) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);

      const sails = await loadSails(api, {
        programId: tokenProgram,
        idl: options.idl,
        idlValidator: makeVftValidator('Burn'),
      });
      const serviceName = findVftService(sails, 'Burn');
      const resolvedAmount = await resolveVftAmount(sails, serviceName, amount, options.units);

      verbose(`Burning ${resolvedAmount} tokens from ${from}`);
      await executeVftTx(api, sails, serviceName, 'Burn', [from, resolvedAmount], account, options.voucher, tokenProgram);
    });
}
