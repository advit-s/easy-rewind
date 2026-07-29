export const API_REQUEST_TIMEOUT_MS = 10_000;
export const API_MAX_RESPONSE_BYTES = 1024 * 1024;

const CREDENTIAL_NAME = /(?:api[_-]?key|token|secret|credential|password)/i;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/i;
const BEARER_AUTHORIZATION = /^Bearer [A-Za-z0-9._~+/=-]{1,4096}$/;

const ERRORS = Object.freeze({
  authentication: Object.freeze({
    code: 'authentication_required',
    message: 'Authenticate the extension again.',
  }),
  conflict: Object.freeze({
    code: 'sync_conflict',
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
  failed: Object.freeze({
    code: 'request_failed',
    message: 'The local backend rejected the request.',
  }),
});

function result(state, status, error) {
  return { state, status, error: { ...error } };
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('baseUrl must be a valid loopback HTTP origin');
  }

  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('baseUrl must be a valid loopback HTTP origin');
  }

  return url.origin;
}

function requestUrl(baseUrl, path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4096 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new TypeError('path must be a safe same-origin API path');
  }

  let url;
  try {
    url = new URL(path, `${baseUrl}/`);
  } catch {
    throw new TypeError('path must be a safe same-origin API path');
  }

  if (url.origin !== baseUrl || url.hash !== '') {
    throw new TypeError('path must be a safe same-origin API path');
  }
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_NAME.test(name)) {
      throw new TypeError('path must be a safe same-origin API path');
    }
  }
  return url.toString();
}

function authorizationHeader(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !BEARER_AUTHORIZATION.test(value)) {
    throw new TypeError('invalid authorization');
  }
  return value;
}

function statusResult(status) {
  if (status === 401 || status === 403) return result('authentication_required', status, ERRORS.authentication);
  if (status === 409) return result('conflict', status, ERRORS.conflict);
  if (status === 426) return result('incompatible', status, ERRORS.incompatible);
  return result('failed', status, ERRORS.failed);
}

async function boundedResponseText(response) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > API_MAX_RESPONSE_BYTES) {
      throw new RangeError('response_too_large');
    }
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > API_MAX_RESPONSE_BYTES) throw new RangeError('response_too_large');
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > API_MAX_RESPONSE_BYTES) {
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

async function readJson(response) {
  if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
    return { error: result('failed', response.status, ERRORS.contentType) };
  }

  let text;
  try {
    text = await boundedResponseText(response);
  } catch (error) {
    if (error instanceof RangeError && error.message === 'response_too_large') {
      return { error: result('failed', response.status, ERRORS.tooLarge) };
    }
    return { error: result('failed', response.status, ERRORS.failed) };
  }

  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: result('failed', response.status, ERRORS.invalidJson) };
  }
}

function createRequestSignal(callerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

export function createApiClient(configuration) {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    typeof configuration.fetch !== 'function' ||
    typeof configuration.getAuthorization !== 'function' ||
    typeof configuration.now !== 'function'
  ) {
    throw new TypeError('API client configuration is invalid');
  }

  const baseUrl = validateBaseUrl(configuration.baseUrl);
  const transport = configuration.fetch;
  const getAuthorization = configuration.getAuthorization;

  async function request(path, options = {}) {
    const url = requestUrl(baseUrl, path);
    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);
    headers.delete('authorization');
    headers.set('accept', 'application/json');

    let authorization;
    try {
      authorization = authorizationHeader(await getAuthorization());
    } catch {
      return result('authentication_required', null, ERRORS.authentication);
    }
    if (authorization !== null) headers.set('authorization', authorization);

    let body;
    if (options.body !== undefined) {
      try {
        body = JSON.stringify(options.body);
      } catch {
        return result('failed', null, ERRORS.failed);
      }
      headers.set('content-type', 'application/json');
    }

    const requestSignal = createRequestSignal(options.signal);
    let response;
    try {
      response = await transport(url, {
        method,
        headers,
        body,
        signal: requestSignal.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (error) {
      if (requestSignal.timedOut()) return result('offline', null, ERRORS.timeout);
      if (requestSignal.signal.aborted) return result('failed', null, ERRORS.aborted);
      if (error instanceof TypeError) return result('offline', null, ERRORS.offline);
      return result('failed', null, ERRORS.failed);
    } finally {
      requestSignal.dispose();
    }

    if (response === null || typeof response !== 'object' || typeof response.status !== 'number' || !response.headers) {
      return result('failed', null, ERRORS.failed);
    }

    const parsed = await readJson(response);
    if (parsed.error) return parsed.error;
    if (!response.ok) return statusResult(response.status);
    return { state: 'ready', status: response.status, data: parsed.data };
  }

  return Object.freeze({
    request,
    health: () => request('/v1/health'),
    push: body => request('/v1/sync/push', { method: 'POST', body }),
    pull: body => request('/v1/sync/pull', { method: 'POST', body }),
  });
}
