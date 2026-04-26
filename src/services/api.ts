import { GearApi } from '@gear-js/api';
import { verbose, CliError, errorMessage, markStage } from '../utils';
import { readConfig } from './config';
import { SmoldotProvider } from './light-client';
import { buildCacheKey, clearMetadataCache, loadMetadataCache, saveMetadataIfNew } from './metadata-cache';

let apiPromise: Promise<GearApi> | null = null;
let apiInstance: GearApi | null = null;
let lightProvider: SmoldotProvider | null = null;
let isDisconnecting = false;

const CONNECTION_TIMEOUT_MS = 10_000;

export function isShuttingDown(): boolean {
  return isDisconnecting;
}

const DEFAULT_ENDPOINT = 'wss://rpc.vara.network';

/**
 * Heuristic: does this error look like @polkadot/api rejected our cached
 * metadata blob (vs. a network/timeout error)? Used to gate the "clear
 * cache and retry without it" recovery path. Substring match because the
 * error path crosses several layers of wrapping inside polkadot/api and
 * the surface message is the only stable handle. Kept narrow on purpose
 * — `'unable to initialize the api'` was tempting but matches genesis-fetch
 * and provider-init failures too, which would clear a perfectly good cache
 * on a transient network error.
 */
function isMetadataError(err: unknown): boolean {
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('magicnumber') ||
    msg.includes('magic number') ||
    msg.includes('unable to decode metadata') ||
    msg.includes('metadata version')
  );
}

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
      // Load on-disk metadata cache. polkadot/api will skip the
      // state_getMetadata RPC if a `${genesisHash}-${specVersion}` key
      // matches the chain it's about to connect to. Auto-invalidates
      // via state_subscribeRuntimeVersion on a runtime upgrade.
      const cachedMetadata = loadMetadataCache();
      const cachedKeyCount = Object.keys(cachedMetadata).length;
      markStage('connect_begin', { endpoint, cachedMetadataKeys: cachedKeyCount });
      const connectPromise = (async (): Promise<GearApi> => {
        const attemptConnect = (metadata: Record<string, `0x${string}`>): Promise<GearApi> =>
          withTimeout(
            GearApi.create({ providerAddress: endpoint, metadata }),
            CONNECTION_TIMEOUT_MS,
            `Connection to ${endpoint} timed out after 10s. Check your network or VARA_WS setting.`,
          );
        let api: GearApi;
        try {
          api = await attemptConnect(cachedMetadata);
        } catch (err) {
          // Cached metadata that passed magic-byte validation but trips
          // @polkadot/api's deeper Metadata wrap (e.g. version/struct
          // mismatch in a future polkadot/api). Clear and retry once
          // without cache so the user isn't stuck with a poisoned entry.
          if (cachedKeyCount > 0 && isMetadataError(err)) {
            verbose(
              `metadata-cache: connect failed with cached metadata (${errorMessage(err)}); clearing cache and retrying`,
            );
            clearMetadataCache();
            api = await attemptConnect({});
          } else {
            throw err;
          }
        }
        apiInstance = api;
        verbose(`Connected to ${endpoint} (spec: ${api.specVersion})`);
        const key = buildCacheKey(api.genesisHash.toHex(), api.runtimeVersion.specVersion.toString());
        const cacheHit = cachedMetadata[key] !== undefined;
        markStage('connect', { spec: api.specVersion, cacheHit });
        // Best-effort cache write. Idempotent; only writes if missing.
        saveMetadataIfNew(api);
        return api;
      })();
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
