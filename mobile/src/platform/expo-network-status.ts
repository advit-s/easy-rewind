import type { NetworkStatus, NetworkStatusSnapshot, Unsubscribe } from './ports.ts';

interface ExpoNetworkState {
  type?: unknown;
  isConnected?: unknown;
  isInternetReachable?: unknown;
}

interface ExpoNetworkSubscription {
  remove(): void;
}

export interface ExpoNetworkModule {
  getNetworkStateAsync(): Promise<ExpoNetworkState>;
  addNetworkStateListener(listener: (state: ExpoNetworkState) => void): ExpoNetworkSubscription;
}

export type ExpoNetworkLoader = () => Promise<ExpoNetworkModule>;

function defaultNetworkLoader(): Promise<ExpoNetworkModule> {
  return import('expo-network') as unknown as Promise<ExpoNetworkModule>;
}

function validateModule(module: ExpoNetworkModule): ExpoNetworkModule {
  if (
    module === null ||
    typeof module !== 'object' ||
    typeof module.getNetworkStateAsync !== 'function' ||
    typeof module.addNetworkStateListener !== 'function'
  ) {
    throw new TypeError('Expo Network is unavailable.');
  }
  return module;
}

function connectionType(type: unknown, connected: boolean): NetworkStatusSnapshot['connectionType'] {
  if (!connected) return 'none';
  const normalized = String(type ?? 'unknown').toLocaleLowerCase('en-US');
  if (normalized.includes('wifi')) return 'wifi';
  if (normalized.includes('cellular')) return 'cellular';
  if (normalized.includes('ethernet')) return 'ethernet';
  if (normalized.includes('none')) return 'none';
  return 'unknown';
}

export function normalizeExpoNetworkState(state: ExpoNetworkState): NetworkStatusSnapshot {
  const connected = state?.isConnected === true;
  return Object.freeze({
    connected,
    internetReachable: typeof state?.isInternetReachable === 'boolean' ? state.isInternetReachable : null,
    connectionType: connectionType(state?.type, connected),
  });
}

export interface CreateExpoNetworkStatusOptions {
  loadNetwork?: ExpoNetworkLoader;
}

export function createExpoNetworkStatus({
  loadNetwork = defaultNetworkLoader,
}: CreateExpoNetworkStatusOptions = {}): NetworkStatus {
  if (typeof loadNetwork !== 'function') {
    throw new TypeError('The Expo Network adapter configuration is invalid.');
  }
  let modulePromise: Promise<ExpoNetworkModule> | undefined;

  function load(): Promise<ExpoNetworkModule> {
    modulePromise ??= Promise.resolve().then(loadNetwork).then(validateModule);
    return modulePromise;
  }

  return Object.freeze({
    async getStatus(): Promise<NetworkStatusSnapshot> {
      return normalizeExpoNetworkState(await (await load()).getNetworkStateAsync());
    },
    subscribe(listener: (status: NetworkStatusSnapshot) => void): Unsubscribe {
      if (typeof listener !== 'function') {
        throw new TypeError('The Expo Network listener is invalid.');
      }
      let active = true;
      let subscription: ExpoNetworkSubscription | undefined;
      void load()
        .then(network => {
          if (!active) return;
          const registered = network.addNetworkStateListener(state => {
            if (active) listener(normalizeExpoNetworkState(state));
          });
          if (registered === null || typeof registered !== 'object' || typeof registered.remove !== 'function') {
            throw new TypeError('Expo Network returned an invalid subscription.');
          }
          subscription = registered;
          if (!active) {
            subscription.remove();
            subscription = undefined;
          }
        })
        .catch(() => {
          // NetworkStatus has no error callback. getStatus remains the observable
          // path for loader failures; a failed subscription emits no false state.
        });

      return () => {
        if (!active) return;
        active = false;
        subscription?.remove();
        subscription = undefined;
      };
    },
  });
}
