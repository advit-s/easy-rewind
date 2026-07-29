import type { SecureCredentialStore } from './ports.ts';

interface ExpoSecureStoreOptions {
  keychainService: string;
  requireAuthentication: false;
}

export interface ExpoSecureStoreModule {
  getItemAsync(key: string, options: ExpoSecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options: ExpoSecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options: ExpoSecureStoreOptions): Promise<void>;
}

export type ExpoSecureStoreLoader = () => Promise<ExpoSecureStoreModule>;

export class ExpoSecureStoreError extends Error {
  readonly code: 'CONFIGURATION_INVALID' | 'READ_FAILED' | 'WRITE_FAILED' | 'REMOVE_FAILED';

  constructor(code: 'CONFIGURATION_INVALID' | 'READ_FAILED' | 'WRITE_FAILED' | 'REMOVE_FAILED', message: string) {
    super(message);
    this.name = 'ExpoSecureStoreError';
    this.code = code;
  }
}

function defaultSecureStoreLoader(): Promise<ExpoSecureStoreModule> {
  return import('expo-secure-store') as unknown as Promise<ExpoSecureStoreModule>;
}

function nativeKey(logicalKey: string): string {
  if (typeof logicalKey !== 'string' || logicalKey.length < 1 || logicalKey.length > 1_024) {
    throw new ExpoSecureStoreError('CONFIGURATION_INVALID', 'The secure credential key is invalid.');
  }
  const bytes = new TextEncoder().encode(logicalKey);
  return `er_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function validateModule(module: ExpoSecureStoreModule): ExpoSecureStoreModule {
  if (
    module === null ||
    typeof module !== 'object' ||
    typeof module.getItemAsync !== 'function' ||
    typeof module.setItemAsync !== 'function' ||
    typeof module.deleteItemAsync !== 'function'
  ) {
    throw new ExpoSecureStoreError('CONFIGURATION_INVALID', 'Expo SecureStore is unavailable.');
  }
  return module;
}

export interface CreateExpoSecureCredentialStoreOptions {
  service?: string;
  loadSecureStore?: ExpoSecureStoreLoader;
}

export function createExpoSecureCredentialStore({
  service = 'easy-rewind.sync.credentials',
  loadSecureStore = defaultSecureStoreLoader,
}: CreateExpoSecureCredentialStoreOptions = {}): SecureCredentialStore {
  if (
    typeof service !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(service) ||
    typeof loadSecureStore !== 'function'
  ) {
    throw new ExpoSecureStoreError('CONFIGURATION_INVALID', 'The secure credential store configuration is invalid.');
  }

  const options = Object.freeze({
    keychainService: service,
    requireAuthentication: false,
  } as const);
  let modulePromise: Promise<ExpoSecureStoreModule> | undefined;

  function load(): Promise<ExpoSecureStoreModule> {
    modulePromise ??= Promise.resolve().then(loadSecureStore).then(validateModule);
    return modulePromise;
  }

  return Object.freeze({
    async get(key: string): Promise<string | null> {
      try {
        return await (await load()).getItemAsync(nativeKey(key), options);
      } catch (error) {
        if (error instanceof ExpoSecureStoreError && error.code === 'CONFIGURATION_INVALID') throw error;
        throw new ExpoSecureStoreError('READ_FAILED', 'The secure credential could not be read.');
      }
    },
    async set(key: string, value: string): Promise<void> {
      if (typeof value !== 'string' || value.length < 1) {
        throw new ExpoSecureStoreError('CONFIGURATION_INVALID', 'The secure credential value is invalid.');
      }
      try {
        await (await load()).setItemAsync(nativeKey(key), value, options);
      } catch (error) {
        if (error instanceof ExpoSecureStoreError && error.code === 'CONFIGURATION_INVALID') throw error;
        throw new ExpoSecureStoreError('WRITE_FAILED', 'The secure credential could not be stored.');
      }
    },
    async remove(key: string): Promise<void> {
      try {
        await (await load()).deleteItemAsync(nativeKey(key), options);
      } catch (error) {
        if (error instanceof ExpoSecureStoreError && error.code === 'CONFIGURATION_INVALID') throw error;
        throw new ExpoSecureStoreError('REMOVE_FAILED', 'The secure credential could not be removed.');
      }
    },
  });
}
