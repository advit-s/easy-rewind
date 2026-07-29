const STORAGE_KEY = 'localInstallAuthorization';
const LOCAL_INSTALL_AUTHORIZATION = /^Bearer eri_[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9_-]{43}$/;
const INVALID_CONNECTION_CODE = 'Invalid desktop connection code.';

export function isValidLocalAuthorization(value) {
  return typeof value === 'string' && LOCAL_INSTALL_AUTHORIZATION.test(value);
}

export function createSessionAuthorizationStore({ storageArea } = {}) {
  if (
    !storageArea ||
    typeof storageArea.get !== 'function' ||
    typeof storageArea.set !== 'function' ||
    typeof storageArea.remove !== 'function'
  ) {
    throw new TypeError('Session storage is unavailable.');
  }

  async function getAuthorization() {
    const stored = await storageArea.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    if (value === undefined) return null;
    if (!isValidLocalAuthorization(value)) {
      await storageArea.remove(STORAGE_KEY);
      return null;
    }
    return value;
  }

  async function set(value) {
    if (!isValidLocalAuthorization(value)) {
      throw new TypeError(INVALID_CONNECTION_CODE);
    }
    await storageArea.set({ [STORAGE_KEY]: value });
  }

  async function clear() {
    await storageArea.remove(STORAGE_KEY);
  }

  return Object.freeze({ clear, getAuthorization, set });
}
