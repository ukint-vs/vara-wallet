import { GearApi } from '@gear-js/api';
import { verbose, CliError } from '../utils';
import { readConfig } from './config';
import { SmoldotProvider } from './light-client';

let apiPromise: Promise<GearApi> | null = null;
let apiInstance: GearApi | null = null;
let lightProvider: SmoldotProvider | null = null;
let isDisconnecting = false;

const CONNECTION_TIMEOUT_MS = 10_000;

export function isShuttingDown(): boolean {
  return isDisconnecting;
}

const DEFAULT_ENDPOINT = 'wss://rpc.vara.network';

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CliError(message, 'CONNECTION_TIMEOUT')), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

export async function getApi(wsEndpoint?: string): Promise<GearApi> {
  const config = readConfig();
  const endpoint = wsEndpoint || process.env.VARA_WS || config.wsEndpoint || DEFAULT_ENDPOINT;
  const useLightClient = process.env.VARA_LIGHT === '1' || endpoint === 'light';

  if (!apiPromise) {
    if (useLightClient) {
      verbose('Starting light client (smoldot)...');
      lightProvider = new SmoldotProvider();
      const connectPromise = (async () => {
        await withTimeout(
          lightProvider!.connect(),
          CONNECTION_TIMEOUT_MS,
          'Light client failed to connect after 10s. Use --ws instead.',
        );
        verbose('Light client connected, initializing API...');
        const api = await GearApi.create({ provider: lightProvider as any });
        apiInstance = api;
        verbose(`Light client ready (spec: ${api.specVersion})`);
        return api;
      })();
      apiPromise = connectPromise.catch((err) => {
        apiPromise = null;
        apiInstance = null;
        throw err;
      });
    } else {
      verbose(`Connecting to ${endpoint}`);
      const connectPromise = withTimeout(
        GearApi.create({ providerAddress: endpoint }),
        CONNECTION_TIMEOUT_MS,
        `Connection to ${endpoint} timed out after 10s. Check your network or VARA_WS setting.`,
      ).then((api) => {
        apiInstance = api;
        verbose(`Connected to ${endpoint} (spec: ${api.specVersion})`);
        return api;
      });
      apiPromise = connectPromise.catch((err) => {
        apiPromise = null;
        apiInstance = null;
        throw err;
      });
    }
  }

  return apiPromise;
}

// Filter @polkadot's RPC-CORE disconnect noise from stderr.
// The logger writes through console.error() → process.stderr.write().
// Patching at the stderr level is simpler and guaranteed to catch it
// regardless of how esbuild bundles module scopes.
const origStderrWrite = process.stderr.write.bind(process.stderr);
const rpcCoreRe = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+RPC-CORE:/;
process.stderr.write = ((...args: unknown[]) => {
  const chunk = args[0];
  const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
  if (rpcCoreRe.test(s)) return true;
  return (origStderrWrite as (...a: unknown[]) => boolean)(...args);
}) as typeof process.stderr.write;

export function disconnectApi(): void {
  isDisconnecting = true;

  // Disconnect light client first to avoid race conditions
  // where @polkadot/api tries to resubscribe during teardown
  if (lightProvider) {
    lightProvider.disconnect().catch(() => {});
    lightProvider = null;
  }

  if (apiInstance) {
    try {
      apiInstance.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown
    }
    apiInstance = null;
    apiPromise = null;
  }
}

// Clean up on exit (signal handlers are in app.ts)
process.on('exit', disconnectApi);
