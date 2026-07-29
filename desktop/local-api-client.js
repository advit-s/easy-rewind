'use strict';

const DESKTOP_LOCAL_API_BASE_URL = 'http://127.0.0.1:3210';
const LOCAL_API_REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_API_MAX_RESPONSE_BYTES = 1024 * 1024;

const BEARER_AUTHORIZATION = /^Bearer [A-Za-z0-9._~+/=-]{1,4096}$/;
const CREDENTIAL_QUERY_NAME = /(?:api[_-]?key|authorization|credential|password|secret|token)/i;
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$/i;

const SAFE_ERRORS = Object.freeze({
  aborted: Object.freeze({
    code: 'request_aborted',
    message: 'The request was cancelled.',
  }),
  authentication: Object.freeze({
    code: 'authentication_required',
    message: 'Authenticate the desktop application again.',
  }),
  conflict: Object.freeze({
    code: 'sync_conflict',
    message: 'The local backend reported a conflict.',
  }),
  contentType: Object.freeze({
    code: 'invalid_content_type',
    message: 'The local backend returned an invalid response.',
  }),
  failed: Object.freeze({
    code: 'request_failed',
    message: 'The local backend rejected the request.',
  }),
  incompatible: Object.freeze({
    code: 'backend_incompatible',
    message: 'Update Easy Rewind before continuing.',
  }),
  invalidJson: Object.freeze({
    code: 'invalid_json',
    message: 'The local backend returned invalid JSON.',
  }),
  offline: Object.freeze({
    code: 'backend_offline',
    message: 'The local backend is unavailable.',
  }),
  timeout: Object.freeze({
    code: 'request_timeout',
    message: 'The local backend did not respond in time.',
  }),
  tooLarge: Object.freeze({
    code: 'response_too_large',
    message: 'The local backend response was too large.',
  }),
});

function errorResult(state, status, error) {
  return {
    error: { code: error.code, message: error.message },
    state,
    status,
  };
}

function assertConfiguration(configuration) {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    configuration.baseUrl !== DESKTOP_LOCAL_API_BASE_URL ||
    typeof configuration.getAuthorization !== 'function' ||
    typeof configuration.httpRequest !== 'function'
  ) {
    throw new TypeError('Local API client requires the exact desktop loopback origin and valid adapters');
  }
}

function safeRequestUrl(path) {
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
    url = new URL(path, `${DESKTOP_LOCAL_API_BASE_URL}/`);
  } catch {
    throw new TypeError('path must be a safe same-origin API path');
  }

  if (url.origin !== DESKTOP_LOCAL_API_BASE_URL || url.hash !== '') {
    throw new TypeError('path must be a safe same-origin API path');
  }
  for (const queryName of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAME.test(queryName)) {
      throw new TypeError('path must be a safe same-origin API path');
    }
  }
  return url.toString();
}

function safeAuthorization(value) {
  if (typeof value !== 'string' || !BEARER_AUTHORIZATION.test(value)) {
    throw new TypeError('Install authorization is unavailable');
  }
  return value;
}

function safeMethod(value) {
  const method = value ?? 'GET';
  if (typeof method !== 'string' || !/^[A-Z]{3,10}$/.test(method)) {
    throw new TypeError('method must be an uppercase HTTP token');
  }
  return method;
}

function safeHeaders(options, authorization, hasBody) {
  const headers = {
    accept: 'application/json',
    authorization,
  };
  const requestId = options?.headers?.['x-request-id'] ?? options?.headers?.['X-Request-Id'];
  if (typeof requestId === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(requestId)) {
    headers['x-request-id'] = requestId;
  }
  if (hasBody) headers['content-type'] = 'application/json';
  return headers;
}

function responseHeader(headers, name) {
  if (headers && typeof headers.get === 'function') return headers.get(name);
  if (headers === null || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function byteChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new TypeError('Invalid response body');
}

async function boundedBody(body) {
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let size = 0;
    for await (const value of body) {
      const chunk = byteChunk(value);
      size += chunk.byteLength;
      if (size > LOCAL_API_MAX_RESPONSE_BYTES) throw new RangeError('response_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  const bytes = byteChunk(body ?? '');
  if (bytes.byteLength > LOCAL_API_MAX_RESPONSE_BYTES) throw new RangeError('response_too_large');
  return bytes;
}

function validateResponse(response) {
  const statusCode = response?.statusCode;
  if (
    response === null ||
    typeof response !== 'object' ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599 ||
    response.headers === null ||
    typeof response.headers !== 'object'
  ) {
    throw new TypeError('Invalid local backend response');
  }
  return statusCode;
}

async function parseResponse(response) {
  const status = validateResponse(response);
  const declaredLength = Number(responseHeader(response.headers, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > LOCAL_API_MAX_RESPONSE_BYTES) {
    return {
      error: errorResult('failed', status, SAFE_ERRORS.tooLarge),
      status,
    };
  }
  if (!JSON_CONTENT_TYPE.test(String(responseHeader(response.headers, 'content-type') ?? ''))) {
    return {
      error: errorResult('failed', status, SAFE_ERRORS.contentType),
      status,
    };
  }

  let bytes;
  try {
    bytes = await boundedBody(response.body);
  } catch (error) {
    return {
      error:
        error instanceof RangeError
          ? errorResult('failed', status, SAFE_ERRORS.tooLarge)
          : errorResult('failed', status, SAFE_ERRORS.failed),
      status,
    };
  }

  try {
    return { data: JSON.parse(bytes.toString('utf8')), status };
  } catch {
    return {
      error: errorResult('failed', status, SAFE_ERRORS.invalidJson),
      status,
    };
  }
}

function httpError(status) {
  if (status === 401 || status === 403) {
    return errorResult('authentication_required', status, SAFE_ERRORS.authentication);
  }
  if (status === 409) return errorResult('conflict', status, SAFE_ERRORS.conflict);
  if (status === 426) return errorResult('incompatible', status, SAFE_ERRORS.incompatible);
  return errorResult('failed', status, SAFE_ERRORS.failed);
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
  }, LOCAL_API_REQUEST_TIMEOUT_MS);

  return {
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
    signal: controller.signal,
    timedOut: () => timedOut,
  };
}

function runWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(new Error('request_interrupted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = finish(reject);
    signal.addEventListener('abort', onAbort, { once: true });

    let pending;
    try {
      pending = operation();
    } catch (error) {
      finish(reject)(error);
      return;
    }
    Promise.resolve(pending).then(finish(resolve), finish(reject));
  });
}

function interruptedResult(requestSignal) {
  return requestSignal.timedOut()
    ? errorResult('offline', null, SAFE_ERRORS.timeout)
    : errorResult('failed', null, SAFE_ERRORS.aborted);
}

function createLocalApiClient(configuration) {
  assertConfiguration(configuration);
  const getAuthorization = configuration.getAuthorization;
  const httpRequest = configuration.httpRequest;

  async function request(path, options = {}) {
    const url = safeRequestUrl(path);
    const method = safeMethod(options.method);
    const requestSignal = createRequestSignal(options.signal);

    try {
      let authorization;
      try {
        authorization = safeAuthorization(await runWithSignal(() => getAuthorization(), requestSignal.signal));
      } catch {
        if (requestSignal.signal.aborted) return interruptedResult(requestSignal);
        return errorResult('authentication_required', null, SAFE_ERRORS.authentication);
      }

      let body;
      if (options.body !== undefined) {
        try {
          body = JSON.stringify(options.body);
        } catch {
          return errorResult('failed', null, SAFE_ERRORS.failed);
        }
      }

      let response;
      try {
        response = await runWithSignal(
          () =>
            httpRequest({
              body,
              headers: safeHeaders(options, authorization, body !== undefined),
              maxResponseBytes: LOCAL_API_MAX_RESPONSE_BYTES,
              method,
              signal: requestSignal.signal,
              timeoutMs: LOCAL_API_REQUEST_TIMEOUT_MS,
              url,
            }),
          requestSignal.signal
        );
      } catch {
        if (requestSignal.signal.aborted) return interruptedResult(requestSignal);
        return errorResult('offline', null, SAFE_ERRORS.offline);
      }

      let parsed;
      try {
        parsed = await runWithSignal(() => parseResponse(response), requestSignal.signal);
      } catch {
        if (requestSignal.signal.aborted) return interruptedResult(requestSignal);
        return errorResult('failed', null, SAFE_ERRORS.failed);
      }
      if (parsed.error) return parsed.error;
      if (parsed.status < 200 || parsed.status >= 300) return httpError(parsed.status);
      return {
        data: parsed.data,
        state: 'ready',
        status: parsed.status,
      };
    } finally {
      requestSignal.dispose();
    }
  }

  return Object.freeze({ request });
}

module.exports = {
  DESKTOP_LOCAL_API_BASE_URL,
  LOCAL_API_MAX_RESPONSE_BYTES,
  LOCAL_API_REQUEST_TIMEOUT_MS,
  createLocalApiClient,
};
