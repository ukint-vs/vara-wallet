import { Command } from 'commander';
import { Sails } from 'sails-js';
import { GearApi } from '@gear-js/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { getApi } from '../services/api';
import { resolveAccount, AccountOptions } from '../services/account';
import { loadSails } from '../services/sails';
import { readConfig } from '../services/config';
import { resolveBlockNumber } from '../services/tx-executor';
import { validateVoucher } from '../services/voucher-validator';
import { output, verbose, CliError, minimalToVara, toMinimalUnits, addressToHex } from '../utils';
import { BUNDLED_DEX_FACTORY_IDLS, BUNDLED_DEX_PAIR_IDLS, BUNDLED_VFT_IDLS } from '../idl/bundled-idls';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZERO_ADDRESS = '0x' + '0'.repeat(64);
const MAX_SLIPPAGE_BPS = 5000;
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const DEFAULT_DEADLINE_SECONDS = 300; // 5 minutes
const PAIRS_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function findDexService(sails: Sails, methodName: string): string {
  for (const [serviceName, service] of Object.entries(sails.services)) {
    if (methodName in service.queries || methodName in service.functions) {
      return serviceName;
    }
  }
  const available = Object.keys(sails.services).join(', ');
  throw new CliError(
    `No service with method "${methodName}" found. Available services: ${available}`,
    'DEX_SERVICE_NOT_FOUND',
  );
}

function makeDexValidator(methodName: string): (sails: Sails) => boolean {
  return (sails: Sails) => {
    for (const service of Object.values(sails.services)) {
      if (methodName in service.queries || methodName in service.functions) {
        return true;
      }
    }
    return false;
  };
}

function resolveFactoryAddress(opts: { factory?: string }): string {
  if (opts.factory) {
    verbose(`Using factory from --factory flag: ${opts.factory}`);
    return addressToHex(opts.factory);
  }

  const envFactory = process.env.VARA_DEX_FACTORY;
  if (envFactory) {
    verbose(`Using factory from VARA_DEX_FACTORY env: ${envFactory}`);
    return addressToHex(envFactory);
  }

  const config = readConfig();
  if (config.dexFactoryAddress) {
    verbose(`Using factory from config: ${config.dexFactoryAddress}`);
    return addressToHex(config.dexFactoryAddress);
  }

  throw new CliError(
    'No DEX factory address configured. Use --factory <addr>, set VARA_DEX_FACTORY env, or add dexFactoryAddress to config.',
    'DEX_FACTORY_NOT_CONFIGURED',
  );
}

async function loadFactorySails(
  api: GearApi,
  factoryAddress: string,
  opts: { idl?: string },
): Promise<Sails> {
  return loadSails(api, {
    programId: factoryAddress,
    idl: opts.idl,
    idlValidator: makeDexValidator('GetPair'),
    bundledIdls: BUNDLED_DEX_FACTORY_IDLS,
  });
}

async function loadPairSails(
  api: GearApi,
  pairAddress: string,
  opts: { idl?: string },
): Promise<Sails> {
  return loadSails(api, {
    programId: pairAddress,
    idl: opts.idl,
    idlValidator: makeDexValidator('SwapExactTokensForTokens'),
    bundledIdls: BUNDLED_DEX_PAIR_IDLS,
  });
}

function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = addressToHex(tokenA);
  const b = addressToHex(tokenB);
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

async function resolvePairAddress(
  factorySails: Sails,
  tokenA: string,
  tokenB: string,
): Promise<string> {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const serviceName = findDexService(factorySails, 'GetPair');
  const query = factorySails.services[serviceName].queries['GetPair'];
  const result = await query(token0, token1).call();
  const pairAddress = String(result);

  if (!pairAddress || pairAddress === ZERO_ADDRESS || pairAddress === '0x' || pairAddress === '') {
    throw new CliError(
      `No trading pair found for ${token0} / ${token1}`,
      'PAIR_NOT_FOUND',
    );
  }

  verbose(`Resolved pair address: ${pairAddress}`);
  return pairAddress;
}

async function resolveTokenDirection(
  pairSails: Sails,
  tokenIn: string,
  tokenOut: string,
): Promise<{ is_token0_to_token1: boolean; token0: string; token1: string }> {
  const serviceName = findDexService(pairSails, 'GetTokens');
  const query = pairSails.services[serviceName].queries['GetTokens'];
  const result = await query().call();

  // GetTokens returns a struct { actor_id, actor_id } — access as tuple
  const tokens = result as unknown as [string, string];
  const token0 = String(tokens[0]);
  const token1 = String(tokens[1]);

  const inHex = addressToHex(tokenIn).toLowerCase();
  const outHex = addressToHex(tokenOut).toLowerCase();

  if (inHex === token0.toLowerCase() && outHex === token1.toLowerCase()) {
    return { is_token0_to_token1: true, token0, token1 };
  }
  if (inHex === token1.toLowerCase() && outHex === token0.toLowerCase()) {
    return { is_token0_to_token1: false, token0, token1 };
  }

  throw new CliError(
    `Tokens ${tokenIn} and ${tokenOut} do not match pair tokens ${token0} / ${token1}`,
    'TOKEN_MISMATCH',
  );
}

async function resolveDeadline(api: GearApi, seconds?: number): Promise<bigint> {
  const secs = seconds || DEFAULT_DEADLINE_SECONDS;
  if (secs <= 0 || !Number.isFinite(secs)) {
    throw new CliError(`Invalid deadline: ${secs} seconds. Must be a positive number.`, 'INVALID_DEADLINE');
  }
  const now = await api.query.timestamp.now();
  const currentMs = BigInt(now.toString());
  const offsetMs = BigInt(secs * 1000);
  return currentMs + offsetMs;
}

export function computeMinAmount(amount: bigint, slippageBps: number): bigint {
  validateSlippage(slippageBps);
  return amount * (10000n - BigInt(slippageBps)) / 10000n;
}

export function computeMaxAmount(amount: bigint, slippageBps: number): bigint {
  validateSlippage(slippageBps);
  const numerator = amount * (10000n + BigInt(slippageBps));
  // Ceiling division: (a + b - 1) / b
  return (numerator + 9999n) / 10000n;
}

export function validateSlippage(bps: number): void {
  if (!Number.isFinite(bps) || !Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new CliError(
      `Invalid slippage: ${bps} bps. Must be between 0 and ${MAX_SLIPPAGE_BPS} (0-50%).`,
      'INVALID_SLIPPAGE',
    );
  }
}

export function validatePositiveAmount(amount: bigint, label: string): void {
  if (amount <= 0n) {
    throw new CliError(
      `Invalid ${label}: must be greater than zero.`,
      'INVALID_AMOUNT',
    );
  }
}

export function computePriceImpact(
  amountIn: bigint,
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
): string {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) {
    return '0';
  }
  // Spot price: reserveOut / reserveIn
  // Execution price: amountOut / amountIn
  // Price impact = 1 - (executionPrice / spotPrice)
  //              = 1 - (amountOut * reserveIn) / (amountIn * reserveOut)
  const spotNumerator = amountOut * reserveIn;
  const spotDenominator = amountIn * reserveOut;

  if (spotDenominator === 0n) return '0';

  // Calculate impact as basis points for precision
  const impactBps = 10000n - (spotNumerator * 10000n / spotDenominator);
  const impactPct = Math.max(0, Number(impactBps) / 100);
  return impactPct.toFixed(2);
}

async function queryTokenDecimals(api: GearApi, tokenAddress: string): Promise<number | null> {
  try {
    const sails = await loadSails(api, {
      programId: tokenAddress,
      idlValidator: makeDexValidator('Decimals'),
      bundledIdls: BUNDLED_VFT_IDLS,
    });
    for (const service of Object.values(sails.services)) {
      const decQuery = service.queries['Decimals'];
      if (decQuery) {
        const dec = await decQuery().call();
        return Number(dec);
      }
    }
  } catch {
    // Token may not support Decimals
  }
  return null;
}

async function queryTokenSymbol(api: GearApi, tokenAddress: string): Promise<string | null> {
  try {
    const sails = await loadSails(api, {
      programId: tokenAddress,
      idlValidator: makeDexValidator('Symbol'),
      bundledIdls: BUNDLED_VFT_IDLS,
    });
    for (const service of Object.values(sails.services)) {
      const symQuery = service.queries['Symbol'];
      if (symQuery) {
        const sym = await symQuery().call();
        return String(sym);
      }
    }
  } catch {
    // Token may not support Symbol
  }
  return null;
}

async function resolveTokenAmount(
  api: GearApi,
  tokenAddress: string,
  amount: string,
  units?: string,
): Promise<bigint> {
  if (units !== undefined && units !== 'raw' && units !== 'token') {
    throw new CliError(
      `Invalid --units value: "${units}". Must be "raw" or "token".`,
      'INVALID_UNITS',
    );
  }

  if (units === 'token') {
    const decimals = await queryTokenDecimals(api, tokenAddress);
    if (decimals === null) {
      throw new CliError(
        'Cannot use --units token: Decimals query is not available on this token program.',
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
      `Invalid amount: "${amount}". Use a whole number for raw units, or --units token for decimal amounts.`,
      'INVALID_AMOUNT',
    );
  }
}

async function ensureApproval(
  api: GearApi,
  tokenProgram: string,
  owner: string,
  spender: string,
  requiredAmount: bigint,
  account: KeyringPair,
): Promise<void> {
  verbose(`Checking allowance for ${tokenProgram}: owner=${owner}, spender=${spender}`);

  const sails = await loadSails(api, {
    programId: tokenProgram,
    idlValidator: makeDexValidator('Allowance'),
    bundledIdls: BUNDLED_VFT_IDLS,
  });

  // Find service with Allowance
  let serviceName: string | null = null;
  for (const [name, service] of Object.entries(sails.services)) {
    if ('Allowance' in service.queries) {
      serviceName = name;
      break;
    }
  }
  if (!serviceName) {
    throw new CliError('Token does not support Allowance query', 'VFT_SERVICE_NOT_FOUND');
  }

  const allowance = BigInt(await sails.services[serviceName].queries['Allowance'](owner, spender).call());
  verbose(`Current allowance: ${allowance}, required: ${requiredAmount}`);

  if (allowance >= requiredAmount) {
    verbose('Allowance sufficient, skipping approval');
    return;
  }

  // If existing non-zero allowance, reset to 0 first (some VFT impls require this)
  if (allowance > 0n) {
    verbose('Resetting existing allowance to 0 before approving new amount');
    const resetFunc = sails.services[serviceName].functions['Approve'];
    const resetTx = resetFunc(spender, 0n);
    resetTx.withAccount(account);
    await resetTx.calculateGas();
    const resetResult = await resetTx.signAndSend();
    await resetResult.response();
    verbose('Allowance reset to 0');
  }

  verbose(`Approving ${requiredAmount} for ${spender}`);
  const approveFunc = sails.services[serviceName].functions['Approve'];
  const approveTx = approveFunc(spender, requiredAmount);
  approveTx.withAccount(account);
  await approveTx.calculateGas();
  const result = await approveTx.signAndSend();
  await result.response();
  verbose(`Approval confirmed in block ${result.blockHash}`);
}

async function executeDexTx(
  api: GearApi,
  sails: Sails,
  serviceName: string,
  methodName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  account: KeyringPair,
  extraOutput?: Record<string, unknown>,
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
  const response = await result.response();
  const blockNumber = await resolveBlockNumber(api, result.blockHash);

  output({
    txHash: result.txHash,
    blockHash: result.blockHash,
    blockNumber,
    messageId: result.msgId,
    voucherId: voucher ?? null,
    result: response,
    ...extraOutput,
  });
}

/** Run promises with concurrency limit */
async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function parseSlippage(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SLIPPAGE_BPS;
  const bps = Number(value);
  if (!Number.isFinite(bps)) {
    throw new CliError(`Invalid --slippage value: "${value}". Must be a number (basis points).`, 'INVALID_SLIPPAGE');
  }
  validateSlippage(bps);
  return bps;
}

// ---------------------------------------------------------------------------
// Command interfaces
// ---------------------------------------------------------------------------

interface DexGlobalOptions {
  ws?: string;
  factory?: string;
  idl?: string;
  units?: string;
  slippage?: string;
  deadline?: string;
  skipApprove?: boolean;
  voucher?: string;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDexCommand(program: Command): void {
  const dex = program.command('dex').description('DEX (decentralized exchange) operations');

  // ── dex pairs ─────────────────────────────────────────────────────────
  dex
    .command('pairs')
    .description('List all trading pairs')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local Factory IDL file')
    .option('--limit <n>', 'max pairs to return', undefined)
    .action(async (options: { factory?: string; idl?: string; limit?: string }) => {
      const opts = program.optsWithGlobals() as DexGlobalOptions;
      const api = await getApi(opts.ws);
      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });

      const serviceName = findDexService(factorySails, 'Pairs');
      const query = factorySails.services[serviceName].queries['Pairs'];
      const rawPairs = await query().call();

      // Pairs returns vec struct { struct { actor_id, actor_id }, actor_id }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let pairs = (rawPairs as any[]).map((p: any) => {
        const tokens = p[0] || p.tokens || p;
        const pairAddr = p[1] || p.pair_address || p.pairAddress;
        return {
          token0: String(tokens[0] || tokens.token0),
          token1: String(tokens[1] || tokens.token1),
          pairAddress: String(pairAddr),
        };
      });

      const limit = options.limit ? parseInt(options.limit, 10) : undefined;
      if (limit && limit > 0) {
        pairs = pairs.slice(0, limit);
      }

      // Enrich with token symbols (concurrency-limited, functional — no shared mutation)
      const symbolTasks = pairs.flatMap((p) => [
        () => queryTokenSymbol(api, p.token0),
        () => queryTokenSymbol(api, p.token1),
      ]);

      const symbols = await withConcurrency(symbolTasks, PAIRS_CONCURRENCY);

      // Merge symbols into pairs (symbols array is [pair0_sym0, pair0_sym1, pair1_sym0, ...])
      const enrichedPairs = pairs.map((p, i) => ({
        ...p,
        ...(symbols[i * 2] && { token0Symbol: symbols[i * 2] }),
        ...(symbols[i * 2 + 1] && { token1Symbol: symbols[i * 2 + 1] }),
      }));

      output({ factoryAddress, pairs: enrichedPairs });
    });

  // ── dex pool ──────────────────────────────────────────────────────────
  dex
    .command('pool')
    .description('Query pool info (reserves, prices, tokens)')
    .argument('<token0>', 'first token address (0x...)')
    .argument('<token1>', 'second token address (0x...)')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local IDL file')
    .action(async (token0: string, token1: string, options: { factory?: string; idl?: string }) => {
      const opts = program.optsWithGlobals() as DexGlobalOptions;
      const api = await getApi(opts.ws);
      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });
      const pairAddress = await resolvePairAddress(factorySails, token0, token1);
      const pairSails = await loadPairSails(api, pairAddress, {});

      const pairService = findDexService(pairSails, 'GetReserves');

      // Parallel queries
      const [reserves, tokens] = await Promise.all([
        pairSails.services[pairService].queries['GetReserves']().call(),
        pairSails.services[pairService].queries['GetTokens']().call(),
      ]);

      const reserveTuple = reserves as unknown as [string, string];
      const tokenTuple = tokens as unknown as [string, string];
      const pairToken0 = String(tokenTuple[0]);
      const pairToken1 = String(tokenTuple[1]);
      const reserve0 = BigInt(reserveTuple[0]);
      const reserve1 = BigInt(reserveTuple[1]);

      // Query token metadata in parallel
      const [dec0, dec1, sym0, sym1] = await Promise.all([
        queryTokenDecimals(api, pairToken0),
        queryTokenDecimals(api, pairToken1),
        queryTokenSymbol(api, pairToken0),
        queryTokenSymbol(api, pairToken1),
      ]);

      // Normalize prices by decimals using BigInt arithmetic to avoid precision loss
      const PRICE_SCALE = 10n ** 18n;
      let price0Per1: string | null = null;
      let price1Per0: string | null = null;
      if (reserve0 > 0n && reserve1 > 0n) {
        const bigAdj0 = dec0 !== null ? 10n ** BigInt(dec0) : 1n;
        const bigAdj1 = dec1 !== null ? 10n ** BigInt(dec1) : 1n;
        const price0Per1Big = (reserve0 * bigAdj1 * PRICE_SCALE) / (reserve1 * bigAdj0);
        price0Per1 = minimalToVara(price0Per1Big, 18);
        const price1Per0Big = (reserve1 * bigAdj0 * PRICE_SCALE) / (reserve0 * bigAdj1);
        price1Per0 = minimalToVara(price1Per0Big, 18);
      }

      output({
        pairAddress,
        token0: {
          address: pairToken0,
          symbol: sym0,
          decimals: dec0,
          reserve: String(reserve0),
          reserveFormatted: dec0 !== null ? minimalToVara(reserve0, dec0) : null,
        },
        token1: {
          address: pairToken1,
          symbol: sym1,
          decimals: dec1,
          reserve: String(reserve1),
          reserveFormatted: dec1 !== null ? minimalToVara(reserve1, dec1) : null,
        },
        price0Per1: price0Per1 !== null ? price0Per1.toString() : null,
        price1Per0: price1Per0 !== null ? price1Per0.toString() : null,
      });
    });

  // ── dex quote ─────────────────────────────────────────────────────────
  dex
    .command('quote')
    .description('Get swap quote (amount out for given input)')
    .argument('<tokenIn>', 'input token address (0x...)')
    .argument('<tokenOut>', 'output token address (0x...)')
    .argument('<amount>', 'input amount (or output amount with --reverse)')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or token')
    .option('--reverse', 'calculate required input for exact output')
    .action(async (tokenIn: string, tokenOut: string, amount: string, options: {
      factory?: string; idl?: string; units?: string; reverse?: boolean;
    }) => {
      const opts = program.optsWithGlobals() as DexGlobalOptions;
      const api = await getApi(opts.ws);
      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });
      const pairAddress = await resolvePairAddress(factorySails, tokenIn, tokenOut);
      const pairSails = await loadPairSails(api, pairAddress, {});

      const direction = await resolveTokenDirection(pairSails, tokenIn, tokenOut);
      const units = options.units ?? opts.units;
      const inputToken = direction.is_token0_to_token1 ? direction.token0 : direction.token1;
      const outputToken = direction.is_token0_to_token1 ? direction.token1 : direction.token0;
      const resolvedAmount = await resolveTokenAmount(api, options.reverse ? outputToken : inputToken, amount, units);
      validatePositiveAmount(resolvedAmount, 'amount');

      const pairService = findDexService(pairSails, 'GetAmountOut');

      // Get reserves for price impact
      const reserves = await pairSails.services[pairService].queries['GetReserves']().call();
      const reserveTuple = reserves as unknown as [string, string];
      const reserveIn = direction.is_token0_to_token1 ? BigInt(reserveTuple[0]) : BigInt(reserveTuple[1]);
      const reserveOut = direction.is_token0_to_token1 ? BigInt(reserveTuple[1]) : BigInt(reserveTuple[0]);

      let amountIn: bigint;
      let amountOut: bigint;

      if (options.reverse) {
        amountOut = resolvedAmount;
        const result = await pairSails.services[pairService].queries['GetAmountIn'](
          amountOut, direction.is_token0_to_token1,
        ).call();
        amountIn = BigInt(result);
      } else {
        amountIn = resolvedAmount;
        const result = await pairSails.services[pairService].queries['GetAmountOut'](
          amountIn, direction.is_token0_to_token1,
        ).call();
        amountOut = BigInt(result);
      }

      const priceImpactPct = computePriceImpact(amountIn, amountOut, reserveIn, reserveOut);

      // Query decimals for formatting
      const [decIn, decOut] = await Promise.all([
        queryTokenDecimals(api, inputToken),
        queryTokenDecimals(api, outputToken),
      ]);

      if (parseFloat(priceImpactPct) > 5) {
        verbose(`WARNING: High price impact: ${priceImpactPct}%`);
      }

      output({
        tokenIn: inputToken,
        tokenOut: outputToken,
        amountIn: String(amountIn),
        amountOut: String(amountOut),
        amountInFormatted: decIn !== null ? minimalToVara(amountIn, decIn) : null,
        amountOutFormatted: decOut !== null ? minimalToVara(amountOut, decOut) : null,
        priceImpactPct,
        direction: direction.is_token0_to_token1 ? 'token0→token1' : 'token1→token0',
      });
    });

  // ── dex swap ──────────────────────────────────────────────────────────
  dex
    .command('swap')
    .description('Execute a token swap')
    .argument('<tokenIn>', 'input token address (0x...)')
    .argument('<tokenOut>', 'output token address (0x...)')
    .argument('<amount>', 'amount to swap')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or token')
    .option('--slippage <bps>', `slippage tolerance in basis points (default: ${DEFAULT_SLIPPAGE_BPS})`)
    .option('--deadline <seconds>', `tx deadline in seconds (default: ${DEFAULT_DEADLINE_SECONDS})`)
    .option('--exact-out', 'treat amount as exact output (swap tokens for exact tokens)')
    .option('--skip-approve', 'skip automatic token approval')
    .option('--voucher <id>', 'voucher ID to pay for the swap')
    .action(async (tokenIn: string, tokenOut: string, amount: string, options: {
      factory?: string; idl?: string; units?: string; slippage?: string;
      deadline?: string; exactOut?: boolean; skipApprove?: boolean; voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & DexGlobalOptions;
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const slippageBps = parseSlippage(options.slippage ?? opts.slippage);

      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });
      const pairAddress = await resolvePairAddress(factorySails, tokenIn, tokenOut);
      const pairSails = await loadPairSails(api, pairAddress, {});

      const direction = await resolveTokenDirection(pairSails, tokenIn, tokenOut);
      const units = options.units ?? opts.units;
      const inputToken = direction.is_token0_to_token1 ? direction.token0 : direction.token1;
      const outputToken = direction.is_token0_to_token1 ? direction.token1 : direction.token0;

      const pairService = findDexService(pairSails, 'SwapExactTokensForTokens');
      const deadline = await resolveDeadline(api, options.deadline ? parseInt(options.deadline, 10) : undefined);

      // Get reserves for price impact
      const reserves = await pairSails.services[pairService].queries['GetReserves']().call();
      const reserveTuple = reserves as unknown as [string, string];
      const reserveIn = direction.is_token0_to_token1 ? BigInt(reserveTuple[0]) : BigInt(reserveTuple[1]);
      const reserveOut = direction.is_token0_to_token1 ? BigInt(reserveTuple[1]) : BigInt(reserveTuple[0]);

      if (options.exactOut) {
        // Swap tokens for exact tokens
        const amountOut = await resolveTokenAmount(api, outputToken, amount, units);
        validatePositiveAmount(amountOut, 'amount');

        const amountInQuote = BigInt(
          await pairSails.services[pairService].queries['GetAmountIn'](
            amountOut, direction.is_token0_to_token1,
          ).call(),
        );
        const amountInMax = computeMaxAmount(amountInQuote, slippageBps);
        const priceImpactPct = computePriceImpact(amountInQuote, amountOut, reserveIn, reserveOut);

        if (parseFloat(priceImpactPct) > 5) {
          verbose(`WARNING: High price impact: ${priceImpactPct}%`);
        }

        verbose(`Swap: exact out ${amountOut}, max in ${amountInMax}, slippage ${slippageBps}bps, impact ${priceImpactPct}%`);

        if (!options.skipApprove && !opts.skipApprove) {
          await ensureApproval(api, inputToken, account.address, pairAddress, amountInMax, account);
        }

        await executeDexTx(api, pairSails, pairService, 'SwapTokensForExactTokens', [
          amountOut, amountInMax, direction.is_token0_to_token1, deadline,
        ], account, {
          priceImpactPct,
          ...(parseFloat(priceImpactPct) > 5 ? { priceImpactWarning: 'High price impact exceeds 5%' } : {}),
        }, options.voucher ?? opts.voucher, pairAddress);
      } else {
        // Swap exact tokens for tokens
        const amountIn = await resolveTokenAmount(api, inputToken, amount, units);
        validatePositiveAmount(amountIn, 'amount');

        const amountOutQuote = BigInt(
          await pairSails.services[pairService].queries['GetAmountOut'](
            amountIn, direction.is_token0_to_token1,
          ).call(),
        );
        const amountOutMin = computeMinAmount(amountOutQuote, slippageBps);
        const priceImpactPct = computePriceImpact(amountIn, amountOutQuote, reserveIn, reserveOut);

        if (parseFloat(priceImpactPct) > 5) {
          verbose(`WARNING: High price impact: ${priceImpactPct}%`);
        }

        verbose(`Swap: exact in ${amountIn}, min out ${amountOutMin}, slippage ${slippageBps}bps, impact ${priceImpactPct}%`);

        if (!options.skipApprove && !opts.skipApprove) {
          await ensureApproval(api, inputToken, account.address, pairAddress, amountIn, account);
        }

        await executeDexTx(api, pairSails, pairService, 'SwapExactTokensForTokens', [
          amountIn, amountOutMin, direction.is_token0_to_token1, deadline,
        ], account, {
          priceImpactPct,
          ...(parseFloat(priceImpactPct) > 5 ? { priceImpactWarning: 'High price impact exceeds 5%' } : {}),
        }, options.voucher ?? opts.voucher, pairAddress);
      }
    });

  // ── dex add-liquidity ─────────────────────────────────────────────────
  dex
    .command('add-liquidity')
    .description('Add liquidity to a trading pair')
    .argument('<token0>', 'first token address (0x...)')
    .argument('<token1>', 'second token address (0x...)')
    .argument('<amount0>', 'desired amount of first token')
    .argument('<amount1>', 'desired amount of second token')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or token')
    .option('--slippage <bps>', `slippage tolerance in basis points (default: ${DEFAULT_SLIPPAGE_BPS})`)
    .option('--deadline <seconds>', `tx deadline in seconds (default: ${DEFAULT_DEADLINE_SECONDS})`)
    .option('--skip-approve', 'skip automatic token approval')
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (token0: string, token1: string, amount0: string, amount1: string, options: {
      factory?: string; idl?: string; units?: string; slippage?: string;
      deadline?: string; skipApprove?: boolean; voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & DexGlobalOptions;
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const slippageBps = parseSlippage(options.slippage ?? opts.slippage);

      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });
      const pairAddress = await resolvePairAddress(factorySails, token0, token1);
      const pairSails = await loadPairSails(api, pairAddress, {});

      // Get canonical token order from the pair
      const pairService = findDexService(pairSails, 'GetTokens');
      const tokens = await pairSails.services[pairService].queries['GetTokens']().call();
      const tokenTuple = tokens as unknown as [string, string];
      const pairToken0 = String(tokenTuple[0]);
      const pairToken1 = String(tokenTuple[1]);

      // Resolve amounts against each token's own decimals
      const units = options.units ?? opts.units;

      // Determine which user argument maps to which pair token
      const token0Hex = addressToHex(token0).toLowerCase();
      let amountA: bigint;
      let amountB: bigint;

      if (token0Hex === pairToken0.toLowerCase()) {
        amountA = await resolveTokenAmount(api, pairToken0, amount0, units);
        amountB = await resolveTokenAmount(api, pairToken1, amount1, units);
      } else {
        amountA = await resolveTokenAmount(api, pairToken0, amount1, units);
        amountB = await resolveTokenAmount(api, pairToken1, amount0, units);
      }

      validatePositiveAmount(amountA, 'amount0');
      validatePositiveAmount(amountB, 'amount1');

      // Query reserves to compute optimal amounts (handles off-ratio deposits)
      const reserveService = findDexService(pairSails, 'GetReserves');
      const reserves = await pairSails.services[reserveService].queries['GetReserves']().call();
      const reserveTuple = reserves as unknown as [string, string];
      const reserveA = BigInt(reserveTuple[0]);
      const reserveB = BigInt(reserveTuple[1]);

      let optimalA = amountA;
      let optimalB = amountB;

      if (reserveA > 0n && reserveB > 0n) {
        // Compute optimal B for desired A: optimalB = amountA * reserveB / reserveA
        const quotedB = amountA * reserveB / reserveA;
        if (quotedB <= amountB) {
          optimalA = amountA;
          optimalB = quotedB;
        } else {
          // Compute optimal A for desired B: optimalA = amountB * reserveA / reserveB
          const quotedA = amountB * reserveA / reserveB;
          optimalA = quotedA;
          optimalB = amountB;
        }
        verbose(`Optimal amounts: ${optimalA}/${optimalB} (from desired ${amountA}/${amountB})`);
      }

      const amountAMin = computeMinAmount(optimalA, slippageBps);
      const amountBMin = computeMinAmount(optimalB, slippageBps);
      const deadline = await resolveDeadline(api, options.deadline ? parseInt(options.deadline, 10) : undefined);

      verbose(`Add liquidity: ${optimalA}/${optimalB}, min ${amountAMin}/${amountBMin}, slippage ${slippageBps}bps`);

      // Auto-approve both tokens
      if (!options.skipApprove && !opts.skipApprove) {
        await ensureApproval(api, pairToken0, account.address, pairAddress, amountA, account);
        await ensureApproval(api, pairToken1, account.address, pairAddress, amountB, account);
      }

      const liquidityService = findDexService(pairSails, 'AddLiquidity');
      await executeDexTx(api, pairSails, liquidityService, 'AddLiquidity', [
        amountA, amountB, amountAMin, amountBMin, deadline,
      ], account, undefined, options.voucher ?? opts.voucher, pairAddress);
    });

  // ── dex remove-liquidity ──────────────────────────────────────────────
  dex
    .command('remove-liquidity')
    .description('Remove liquidity from a trading pair')
    .argument('<token0>', 'first token address (0x...)')
    .argument('<token1>', 'second token address (0x...)')
    .argument('<liquidity>', 'LP token amount to burn')
    .option('--factory <addr>', 'factory program address')
    .option('--idl <path>', 'path to local IDL file')
    .option('--units <type>', 'amount units: raw (default) or token (uses LP decimals)')
    .option('--slippage <bps>', `slippage tolerance in basis points (default: ${DEFAULT_SLIPPAGE_BPS})`)
    .option('--deadline <seconds>', `tx deadline in seconds (default: ${DEFAULT_DEADLINE_SECONDS})`)
    .option('--skip-approve', 'skip automatic token approval')
    .option('--voucher <id>', 'voucher ID to pay for the transaction')
    .action(async (token0: string, token1: string, liquidity: string, options: {
      factory?: string; idl?: string; units?: string; slippage?: string; deadline?: string;
      skipApprove?: boolean; voucher?: string;
    }) => {
      const opts = program.optsWithGlobals() as AccountOptions & DexGlobalOptions;
      const api = await getApi(opts.ws);
      const account = await resolveAccount(opts);
      const slippageBps = parseSlippage(options.slippage ?? opts.slippage);

      const factoryAddress = resolveFactoryAddress({ factory: options.factory ?? opts.factory });
      const factorySails = await loadFactorySails(api, factoryAddress, { idl: options.idl ?? opts.idl });
      const pairAddress = await resolvePairAddress(factorySails, token0, token1);
      const pairSails = await loadPairSails(api, pairAddress, {});

      // Resolve LP token amount (the pair itself is the LP token)
      const units = options.units ?? opts.units;
      const lpAmount = await resolveTokenAmount(api, pairAddress, liquidity, units);
      validatePositiveAmount(lpAmount, 'liquidity');

      // Preview: calculate expected token amounts
      const pairService = findDexService(pairSails, 'CalculateRemoveLiquidity');
      const preview = await pairSails.services[pairService].queries['CalculateRemoveLiquidity'](lpAmount).call();
      const previewTuple = preview as unknown as [string, string];
      const expectedA = BigInt(previewTuple[0]);
      const expectedB = BigInt(previewTuple[1]);

      const amountAMin = computeMinAmount(expectedA, slippageBps);
      const amountBMin = computeMinAmount(expectedB, slippageBps);
      const deadline = await resolveDeadline(api, options.deadline ? parseInt(options.deadline, 10) : undefined);

      verbose(`Remove liquidity: ${lpAmount} LP, expected ${expectedA}/${expectedB}, min ${amountAMin}/${amountBMin}`);

      // Approve LP tokens for the pair contract to burn
      if (!options.skipApprove && !opts.skipApprove) {
        await ensureApproval(api, pairAddress, account.address, pairAddress, lpAmount, account);
      }

      const liquidityService = findDexService(pairSails, 'RemoveLiquidity');
      await executeDexTx(api, pairSails, liquidityService, 'RemoveLiquidity', [
        lpAmount, amountAMin, amountBMin, deadline,
      ], account, undefined, options.voucher ?? opts.voucher, pairAddress);
    });
}
