import { Command } from 'commander';
import { u8aToHex, stringToU8a } from '@polkadot/util';
import { getApi } from '../services/api';
import { resolveAccount, resolveAddress, AccountOptions } from '../services/account';
import { readConfig } from '../services/config';
import { output, verbose, CliError, minimalToVara, varaToMinimal } from '../utils';

const MAINNET_ENDPOINT = 'wss://rpc.vara.network';

const DEFAULT_FAUCET_URL = 'https://faucet.gear-tech.io';
const DEFAULT_TESTNET_WS = 'wss://testnet.vara.network';
const FETCH_TIMEOUT_MS = 10_000;
const MIN_BALANCE_TVARA = '1000';

function resolveFaucetUrl(optionUrl?: string): string {
  if (optionUrl) return optionUrl;
  if (process.env.VARA_FAUCET_URL) return process.env.VARA_FAUCET_URL;
  const config = readConfig();
  if (config.faucetUrl) return config.faucetUrl;
  return DEFAULT_FAUCET_URL;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new CliError('Request timed out', 'CONNECTION_FAILED');
    }
    throw new CliError(`Could not reach faucet: ${error.message}`, 'CONNECTION_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

export function registerFaucetCommand(program: Command): void {
  program
    .command('faucet')
    .description('Request testnet TVARA tokens (proves address ownership via signature)')
    .argument('[address]', 'account address (defaults to configured account)')
    .option('--faucet-url <url>', 'faucet API URL')
    .action(async (address?: string, options?: { faucetUrl?: string }) => {
      const opts = program.optsWithGlobals() as AccountOptions & { ws?: string };

      // Check for mainnet before connecting
      const wsArg = opts.ws || process.env.VARA_WS || readConfig().wsEndpoint;
      if (wsArg === MAINNET_ENDPOINT) {
        throw new CliError(
          'Faucet is for testnet only. Use --network testnet or --ws wss://testnet.vara.network',
          'WRONG_NETWORK',
        );
      }

      const api = await getApi(wsArg || DEFAULT_TESTNET_WS);
      const account = await resolveAccount(opts);
      const resolvedAddress = await resolveAddress(address, opts);
      const faucetUrl = resolveFaucetUrl(options?.faucetUrl);

      verbose(`Using faucet at ${faucetUrl}`);

      // Check current balance
      const balanceBigInt = (await api.balance.findOut(resolvedAddress)).toBigInt();
      const minBalance = varaToMinimal(MIN_BALANCE_TVARA);
      if (balanceBigInt >= minBalance) {
        const balanceVara = minimalToVara(balanceBigInt);
        output({
          status: 'already_funded',
          address: resolvedAddress,
          balance: balanceVara,
          message: `Account already has ${balanceVara} TVARA`,
        });
        return;
      }

      verbose(`Current balance: ${minimalToVara(balanceBigInt)} TVARA, requesting tokens...`);

      // Step 1: Get challenge nonce
      verbose('Requesting challenge nonce...');
      const challengeRes = await fetchWithTimeout(`${faucetUrl}/agent/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: resolvedAddress }),
      });

      if (!challengeRes.ok) {
        const body = await challengeRes.json().catch(() => ({}));
        const msg = (body as any).error || `Challenge request failed (${challengeRes.status})`;
        throw new CliError(msg, challengeRes.status === 429 ? 'RATE_LIMITED' : 'FAUCET_ERROR');
      }

      const { nonce } = (await challengeRes.json()) as { nonce: string };
      if (!nonce) {
        throw new CliError('Invalid response from faucet: missing challenge nonce', 'FAUCET_ERROR');
      }
      verbose(`Got challenge nonce: ${nonce.slice(0, 10)}...`);

      // Step 2: Sign the nonce
      const signature = u8aToHex(account.sign(stringToU8a(nonce)));
      verbose('Signed challenge nonce');

      // Step 3: Submit signed claim
      const genesis = api.genesisHash.toHex();
      verbose(`Submitting claim for ${resolvedAddress} on genesis ${genesis.slice(0, 10)}...`);

      const claimRes = await fetchWithTimeout(`${faucetUrl}/agent/vara-testnet/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: resolvedAddress,
          genesis,
          signature,
          nonce,
        }),
      });

      if (!claimRes.ok) {
        const body = await claimRes.json().catch(() => ({}));
        const msg = (body as any).error || `Claim request failed (${claimRes.status})`;

        if (claimRes.status === 401) {
          throw new CliError(msg, 'AUTH_ERROR');
        }
        if (claimRes.status === 403) {
          throw new CliError(msg, 'FAUCET_LIMIT');
        }
        if (claimRes.status === 429) {
          throw new CliError(msg, 'RATE_LIMITED');
        }
        throw new CliError(msg, 'FAUCET_ERROR');
      }

      output({
        status: 'submitted',
        address: resolvedAddress,
        message: 'TVARA tokens will arrive within ~15 seconds',
      });
    });
}
