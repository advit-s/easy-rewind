const SESSION_KEY = 'easy-rewind.dashboard.install-session';
const AUTHORIZATION = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;

function validProfileId(value) {
  return typeof value === 'string' && value.trim() === value && IDENTIFIER.test(value);
}

function validAuthorization(value) {
  return typeof value === 'string' && AUTHORIZATION.test(value);
}

function requireStorage(storage) {
  if (
    storage === null ||
    typeof storage !== 'object' ||
    typeof storage.getItem !== 'function' ||
    typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function'
  ) {
    throw new TypeError('Session storage is unavailable.');
  }
  return storage;
}

export function createDashboardSession({ sessionStorage = globalThis.sessionStorage } = {}) {
  const storage = requireStorage(sessionStorage);

  async function establish({ authorization, profileId } = {}) {
    if (!validAuthorization(authorization) || !validProfileId(profileId)) {
      throw new TypeError('The dashboard session is invalid.');
    }
    storage.setItem(SESSION_KEY, JSON.stringify({ authorization, profileId }));
  }

  async function read() {
    let parsed;
    try {
      const serialized = storage.getItem(SESSION_KEY);
      if (serialized === null) return null;
      parsed = JSON.parse(serialized);
    } catch {
      storage.removeItem(SESSION_KEY);
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !validAuthorization(parsed.authorization) ||
      !validProfileId(parsed.profileId) ||
      Object.keys(parsed).some(key => !['authorization', 'profileId'].includes(key))
    ) {
      storage.removeItem(SESSION_KEY);
      return null;
    }
    return Object.freeze({
      authorization: parsed.authorization,
      profileId: parsed.profileId,
    });
  }

  async function clear() {
    storage.removeItem(SESSION_KEY);
  }

  return Object.freeze({ establish, read, clear });
}
