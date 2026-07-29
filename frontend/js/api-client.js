export const API_REQUEST_TIMEOUT_MS = 10_000;
export const API_MAX_RESPONSE_BYTES = 1024 * 1024;

const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/i;
const AUTHORIZATION = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const IDENTIFIER = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const SENSITIVE_QUERY_NAME = /(?:api[_-]?key|token|secret|credential|password|profile[_-]?id|profileId)/i;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OWNER_KEYS = new Set(['profileid', 'ownerprofileid']);

const ERRORS = Object.freeze({
  authentication: Object.freeze({
    code: 'authentication_required',
    message: 'Authenticate to Easy Rewind again.',
  }),
  conflict: Object.freeze({
    code: 'conflict',
    message: 'The local backend reported a conflict.',
  }),
  incompatible: Object.freeze({
    code: 'backend_incompatible',
    message: 'Update Easy Rewind before continuing.',
  }),
  offline: Object.freeze({
    code: 'backend_offline',
    message: 'The local backend is unavailable.',
  }),
  timeout: Object.freeze({
    code: 'request_timeout',
    message: 'The local backend did not respond in time.',
  }),
  aborted: Object.freeze({
    code: 'request_aborted',
    message: 'The request was cancelled.',
  }),
  tooLarge: Object.freeze({
    code: 'response_too_large',
    message: 'The local backend response was too large.',
  }),
  contentType: Object.freeze({
    code: 'invalid_content_type',
    message: 'The local backend returned an invalid response.',
  }),
  invalidJson: Object.freeze({
    code: 'invalid_json',
    message: 'The local backend returned invalid JSON.',
  }),
  profile: Object.freeze({
    code: 'profile_isolation_violation',
    message: 'The local backend returned data for a different profile.',
  }),
  failed: Object.freeze({
    code: 'request_failed',
    message: 'The local backend rejected the request.',
  }),
});

function failure(state, status, error) {
  return Object.freeze({
    state,
    status,
    error: Object.freeze({ ...error }),
  });
}

function normalizedOwnerKey(key) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function validProfileId(value) {
  return typeof value === 'string' && value.trim() === value && IDENTIFIER.test(value);
}

function validSession(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.authorization === 'string' &&
    AUTHORIZATION.test(value.authorization) &&
    validProfileId(value.profileId)
  );
}

export function normalizeApiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('API origin must be an exact loopback origin.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('API origin must be an exact loopback origin.');
  }
  return url.origin;
}

export function normalizeApiUrl(origin, path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4096 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new TypeError('Request path must be a safe API path.');
  }
  let url;
  try {
    url = new URL(path, `${origin}/`);
  } catch {
    throw new TypeError('Request path must be a safe API path.');
  }
  if (url.origin !== origin || url.hash !== '') {
    throw new TypeError('Request path must be a safe API path.');
  }
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_NAME.test(name)) {
      throw new TypeError('Request path must be a safe API path.');
    }
  }
  return url.toString();
}

function assertNoProfileOverride(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new TypeError('Request body must be serializable.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoProfileOverride(entry, seen);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (OWNER_KEYS.has(normalizedOwnerKey(key))) {
        throw new TypeError('Request body cannot override profile ownership.');
      }
      assertNoProfileOverride(entry, seen);
    }
  }
  seen.delete(value);
}

function responseMatchesProfile(value, expectedProfileId) {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) {
    return value.every(entry => responseMatchesProfile(entry, expectedProfileId));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (OWNER_KEYS.has(normalizedOwnerKey(key)) && (typeof entry !== 'string' || entry !== expectedProfileId)) {
      return false;
    }
    if (!responseMatchesProfile(entry, expectedProfileId)) return false;
  }
  return true;
}

function responseFailure(status) {
  if (status === 401 || status === 403) {
    return failure('authentication_required', status, ERRORS.authentication);
  }
  if (status === 409) return failure('conflict', status, ERRORS.conflict);
  if (status === 426) return failure('incompatible', status, ERRORS.incompatible);
  return failure('failed', status, ERRORS.failed);
}

async function boundedResponseText(response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > API_MAX_RESPONSE_BYTES) {
      throw new RangeError('response_too_large');
    }
  }

  if (response.body === null || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > API_MAX_RESPONSE_BYTES) throw new RangeError('response_too_large');
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > API_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RangeError('response_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function parseResponse(response) {
  if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
    return { error: ERRORS.contentType };
  }
  let text;
  try {
    text = await boundedResponseText(response);
  } catch (error) {
    return {
      error: error instanceof RangeError && error.message === 'response_too_large' ? ERRORS.tooLarge : ERRORS.failed,
    };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: ERRORS.invalidJson };
  }
}

function createRequestSignal(callerSignal, scheduleTimeout, cancelTimeout) {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = scheduleTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      cancelTimeout(timeout);
      callerSignal?.removeEventListener('abort', forwardAbort);
    },
  };
}

export function createDashboardApiClient({
  fetch: transport = globalThis.fetch,
  location = globalThis.location,
  apiOrigin,
  session,
  scheduleTimeout = globalThis.setTimeout,
  cancelTimeout = globalThis.clearTimeout,
} = {}) {
  if (
    typeof transport !== 'function' ||
    session === null ||
    typeof session !== 'object' ||
    typeof session.read !== 'function' ||
    typeof scheduleTimeout !== 'function' ||
    typeof cancelTimeout !== 'function'
  ) {
    throw new TypeError('Dashboard API client configuration is invalid.');
  }
  const origin = normalizeApiOrigin(apiOrigin ?? location?.origin);

  async function request(path, options = {}) {
    const url = normalizeApiUrl(origin, path);
    const method = String(options.method ?? 'GET').toUpperCase();
    if (!METHODS.has(method)) throw new TypeError('Request method is unsupported.');

    let activeSession;
    try {
      activeSession = await session.read();
    } catch {
      activeSession = null;
    }
    if (!validSession(activeSession)) {
      return failure('authentication_required', null, ERRORS.authentication);
    }

    const headers = new Headers(options.headers);
    for (const name of ['authorization', 'x-user-id', 'x-profile-id', 'x-easy-rewind-profile']) {
      headers.delete(name);
    }
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${activeSession.authorization}`);

    let body;
    if (options.body !== undefined) {
      assertNoProfileOverride(options.body);
      try {
        body = JSON.stringify(options.body);
      } catch {
        throw new TypeError('Request body must be serializable.');
      }
      headers.set('content-type', 'application/json');
    }

    const requestSignal = createRequestSignal(options.signal, scheduleTimeout, cancelTimeout);
    let response;
    try {
      response = await transport(url, {
        method,
        headers,
        body,
        signal: requestSignal.signal,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (error) {
      if (requestSignal.timedOut()) return failure('offline', null, ERRORS.timeout);
      if (requestSignal.signal.aborted) return failure('failed', null, ERRORS.aborted);
      if (error instanceof TypeError) return failure('offline', null, ERRORS.offline);
      return failure('failed', null, ERRORS.failed);
    } finally {
      requestSignal.dispose();
    }

    if (
      response === null ||
      typeof response !== 'object' ||
      typeof response.status !== 'number' ||
      response.headers === undefined
    ) {
      return failure('failed', null, ERRORS.failed);
    }
    if (!response.ok) return responseFailure(response.status);
    if (response.status === 204) {
      return Object.freeze({ state: 'ready', status: response.status, data: null });
    }

    const parsed = await parseResponse(response);
    if (parsed.error !== undefined) return failure('failed', response.status, parsed.error);
    if (!responseMatchesProfile(parsed.data, activeSession.profileId)) {
      return failure('failed', response.status, ERRORS.profile);
    }
    return Object.freeze({
      state: 'ready',
      status: response.status,
      data: parsed.data,
    });
  }

  return Object.freeze({ origin, request });
}
