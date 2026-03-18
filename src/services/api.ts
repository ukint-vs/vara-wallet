import { GearApi } from '@gear-js/api';
import { verbose } from '../utils';
import { SmoldotProvider } from './light-client';

let apiPromise: Promise<GearApi> | null = null;
let apiInstance: GearApi | null = null;
let lightProvider: SmoldotProvider | null = null;
let isDisconnecting = false;

export function isShuttingDown(): boolean {
  return isDisconnecting;
}

const DEFAULT_ENDPOINT = 'wss://rpc.vara.network';

export async function getApi(wsEndpoint?: string): Promise<GearApi> {
  const endpoint = wsEndpoint || process.env.VARA_WS || DEFAULT_ENDPOINT;
  const useLightClient = process.env.VARA_LIGHT === '1' || endpoint === 'light';

  if (!apiPromise) {
    if (useLightClient) {
      verbose('Starting light client (smoldot)...');
      lightProvider = new SmoldotProvider();
      await lightProvider.connect();
      verbose('Light client connected, initializing API...');
      apiPromise = GearApi.create({ provider: lightProvider as any }).then((api) => {
        apiInstance = api;
        verbose(`Light client ready (spec: ${api.specVersion})`);
        return api;
      });
    } else {
      verbose(`Connecting to ${endpoint}`);
      apiPromise = GearApi.create({ providerAddress: endpoint }).then((api) => {
        apiInstance = api;
        verbose(`Connected to ${endpoint} (spec: ${api.specVersion})`);
        return api;
      });
    }
  }

  return apiPromise;
}

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
