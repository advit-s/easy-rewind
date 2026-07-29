'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DESKTOP_LOCAL_API_BASE_URL,
  LOCAL_API_MAX_RESPONSE_BYTES,
  LOCAL_API_REQUEST_TIMEOUT_MS,
  createLocalApiClient,
} = require('./local-api-client');

function jsonResponse(body, { statusCode = 200, headers = {} } = {}) {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    body: encoded,
    headers: {
      'content-length': String(encoded.byteLength),
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    statusCode,
  };
}

function clientWith(httpRequest, overrides = {}) {
  return createLocalApiClient({
    baseUrl: DESKTOP_LOCAL_API_BASE_URL,
    getAuthorization: async () => 'Bearer desktop-sensitive-token',
    httpRequest,
    ...overrides,
  });
}

test('accepts only the exact embedded backend loopback origin', () => {
  assert.equal(DESKTOP_LOCAL_API_BASE_URL, 'http://127.0.0.1:3210');
  assert.doesNotThrow(() => clientWith(async () => jsonResponse({ ok: true })));

  for (const baseUrl of [
    'http://localhost:3210',
    'https://127.0.0.1:3210',
    'http://127.0.0.1:3211',
    'http://127.0.0.1:3210/',
    'http://127.0.0.1:3210/api',
    'http://user:password@127.0.0.1:3210',
    'http://127.0.0.1:3210?token=secret',
  ]) {
    assert.throws(
      () => clientWith(async () => jsonResponse({ ok: true }), { baseUrl }),
      /exact desktop loopback origin/
    );
  }
});

test('puts install authorization only in the header and never sends x-user-id', async () => {
  let observed;
  const client = clientWith(async request => {
    observed = request;
    return jsonResponse({ healthy: true });
  });

  const result = await client.request('/v1/health', {
    headers: {
      authorization: 'Bearer attacker-controlled',
      'x-user-id': 'legacy-user',
      'x-request-id': 'request-1',
    },
  });

  assert.deepEqual(result, {
    data: { healthy: true },
    state: 'ready',
    status: 200,
  });
  assert.equal(observed.url, 'http://127.0.0.1:3210/v1/health');
  assert.equal(observed.headers.authorization, 'Bearer desktop-sensitive-token');
  assert.equal('x-user-id' in observed.headers, false);
  assert.equal(new URL(observed.url).search, '');
  assert.equal(JSON.stringify(result).includes('desktop-sensitive-token'), false);
  assert.equal(JSON.stringify(client).includes('desktop-sensitive-token'), false);
});

test('rejects unsafe paths and credential-shaped query parameters before requesting authorization', async () => {
  let authorizationReads = 0;
  let requestCalls = 0;
  const client = clientWith(
    async () => {
      requestCalls += 1;
      return jsonResponse({ ok: true });
    },
    {
      getAuthorization: async () => {
        authorizationReads += 1;
        return 'Bearer should-not-be-read';
      },
    }
  );

  for (const path of [
    'v1/health',
    '//attacker.test/v1/health',
    'https://attacker.test/v1/health',
    '/v1/health#fragment',
    '/v1/health?token=secret',
    '/v1/health?apiKey=secret',
    '/v1/health?password=secret',
    '/v1/health\u0000',
  ]) {
    await assert.rejects(() => client.request(path), /safe same-origin API path/);
  }
  assert.equal(authorizationReads, 0);
  assert.equal(requestCalls, 0);
});

test('uses a ten-second timeout and a one-MiB JSON response bound', async () => {
  assert.equal(LOCAL_API_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(LOCAL_API_MAX_RESPONSE_BYTES, 1024 * 1024);

  let observed;
  const client = clientWith(async request => {
    observed = request;
    return jsonResponse({ ok: true });
  });
  assert.equal((await client.request('/v1/health')).state, 'ready');
  assert.equal(observed.timeoutMs, 10_000);
  assert.equal(observed.maxResponseBytes, 1024 * 1024);
  assert.equal(observed.signal instanceof AbortSignal, true);

  const oversized = clientWith(async () => ({
    body: Buffer.alloc(LOCAL_API_MAX_RESPONSE_BYTES + 1),
    headers: { 'content-type': 'application/json' },
    statusCode: 200,
  }));
  assert.deepEqual(await oversized.request('/v1/health'), {
    error: {
      code: 'response_too_large',
      message: 'The local backend response was too large.',
    },
    state: 'failed',
    status: 200,
  });
});

test('aborts and returns a stable offline result when ten seconds elapse', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduledDelay;

  globalThis.setTimeout = (callback, delay) => {
    scheduledDelay = delay;
    queueMicrotask(callback);
    return 91;
  };
  globalThis.clearTimeout = () => {};

  try {
    const client = clientWith(
      () => new Promise(resolve => setImmediate(() => resolve(jsonResponse({ tooLate: true }))))
    );
    assert.deepEqual(await client.request('/v1/health'), {
      error: {
        code: 'request_timeout',
        message: 'The local backend did not respond in time.',
      },
      state: 'offline',
      status: null,
    });
    assert.equal(scheduledDelay, 10_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('cancels an in-flight request when its caller aborts', async () => {
  const caller = new AbortController();
  const client = clientWith(() => {
    queueMicrotask(() => caller.abort());
    return new Promise(resolve => setImmediate(() => resolve(jsonResponse({ tooLate: true }))));
  });

  assert.deepEqual(await client.request('/v1/health', { signal: caller.signal }), {
    error: { code: 'request_aborted', message: 'The request was cancelled.' },
    state: 'failed',
    status: null,
  });
});

test('maps authorization, transport, HTTP, content-type, and JSON failures to safe stable errors', async () => {
  const cases = [
    [
      clientWith(async () => {
        throw new Error('network error includes Bearer transport-secret');
      }),
      'backend_offline',
      'offline',
    ],
    [
      clientWith(async () => jsonResponse({ ok: true }), {
        getAuthorization: async () => {
          throw new Error('vault error includes Bearer vault-secret');
        },
      }),
      'authentication_required',
      'authentication_required',
    ],
    [
      clientWith(async () =>
        jsonResponse({ error: { message: 'Bearer server-secret', token: 'server-secret' } }, { statusCode: 409 })
      ),
      'sync_conflict',
      'conflict',
    ],
    [
      clientWith(async () => ({
        body: Buffer.from('Bearer wrong-type-secret'),
        headers: { 'content-type': 'text/plain' },
        statusCode: 200,
      })),
      'invalid_content_type',
      'failed',
    ],
    [
      clientWith(async () => ({
        body: Buffer.from('Bearer invalid-json-secret'),
        headers: { 'content-type': 'application/json' },
        statusCode: 200,
      })),
      'invalid_json',
      'failed',
    ],
  ];

  for (const [client, code, state] of cases) {
    const result = await client.request('/v1/health');
    assert.equal(result.error.code, code);
    assert.equal(result.state, state);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('does not import Electron or expose mutable credential-bearing state', () => {
  assert.equal('electron' in require.cache, false);
  const client = clientWith(async () => jsonResponse({ ok: true }));
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(Object.keys(client), ['request']);
});
