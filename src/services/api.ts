import { GearApi } from '@gear-js/api';
import { verbose } from '../utils';

let apiPromise: Promise<GearApi> | null = null;
let apiInstance: GearApi | null = null;
let isDisconnecting = false;

export function isShuttingDown(): boolean {
  return isDisconnecting;
}

const DEFAULT_ENDPOINT = 'wss://rpc.vara.network';

export async function getApi(wsEndpoint?: string): Promise<GearApi> {
  const endpoint = wsEndpoint || process.env.VARA_WS || DEFAULT_ENDPOINT;

  if (!apiPromise) {
    verbose(`Connecting to ${endpoint}`);
    apiPromise = GearApi.create({ providerAddress: endpoint }).then((api) => {
      apiInstance = api;
      verbose(`Connected to ${endpoint} (spec: ${api.specVersion})`);
      return api;
    });
  }

  return apiPromise;
}

export function disconnectApi(): void {
  if (apiInstance) {
    isDisconnecting = true;
    try {
      apiInstance.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown
    }
    apiInstance = null;
    apiPromise = null;
  }
}

// Graceful shutdown
process.on('exit', disconnectApi);
process.on('SIGINT', () => {
  disconnectApi();
  process.exit(0);
});
process.on('SIGTERM', () => {
  disconnectApi();
  process.exit(0);
});
