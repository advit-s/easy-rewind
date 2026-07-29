import assert from 'node:assert/strict';
import test from 'node:test';

import { API_MAX_RESPONSE_BYTES, API_REQUEST_TIMEOUT_MS, createApiClient } from '../src/api-client.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
    ...init,
  });
}

function clientWith(fetch, overrides = {}) {
  return createApiClient({
    baseUrl: 'http://127.0.0.1:3210',
    fetch,
    getAuthorization: async () => 'Bearer extension-session',
    now: () => 1_234,
    ...overrides,
  });
}

test('accepts only an exact HTTP loopback origin', () => {
  for (const baseUrl of ['http://127.0.0.1:3210', 'http://localhost:3210']) {
    assert.doesNotThrow(() => clientWith(async () => jsonResponse({ ok: true }), { baseUrl }));
  }

  for (const baseUrl of [
    'https://127.0.0.1:3210',
    'http://127.0.0.2:3210',
    'http://[::1]:3210',
    'http://localhost.evil.test:3210',
    'http://user:password@localhost:3210',
    'http://localhost:3210/api',
    'http://localhost:3210/?token=secret',
    'http://localhost:3210/#fragment',
    'http://localhost',
  ]) {
    assert.throws(() => clientWith(async () => jsonResponse({ ok: true }), { baseUrl }), /valid loopback HTTP origin/);
  }
});

test('sends authorization only in headers and keeps request URLs credential-free', async () => {
  const seen = [];
  const client = clientWith(async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ healthy: true });
  });

  const result = await client.request('/v1/health');

  assert.equal(result.state, 'ready');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:3210/v1/health');
  assert.equal(seen[0].init.headers.get('authorization'), 'Bearer extension-session');
  assert.equal(new URL(seen[0].url).search, '');
  assert.equal(JSON.stringify(result).includes('extension-session'), false);
});

test('rejects absolute, cross-origin, malformed, and credential-shaped request paths before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return jsonResponse({ ok: true });
  });

  for (const path of [
    'v1/health',
    '//attacker.example/v1/health',
    'https://attacker.example/v1/health',
    '/v1/health#fragment',
    '/v1/health?token=secret',
    '/v1/health?apiKey=secret',
    '/v1/health?password=secret',
    '/v1/health\u0000',
  ]) {
    await assert.rejects(() => client.request(path), /safe same-origin API path/);
  }
  assert.equal(calls, 0);
});

test('health, push, and pull use the frozen local API routes and JSON bodies', async () => {
  const seen = [];
  const client = clientWith(async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ accepted: true });
  });

  assert.equal((await client.health()).state, 'ready');
  assert.equal((await client.push({ deviceId: 'device-1', changes: [] })).state, 'ready');
  assert.equal((await client.pull({ deviceId: 'device-1', limit: 25 })).state, 'ready');

  assert.deepEqual(
    seen.map(entry => [new URL(entry.url).pathname, entry.init.method]),
    [
      ['/v1/health', 'GET'],
      ['/v1/sync/push', 'POST'],
      ['/v1/sync/pull', 'POST'],
    ]
  );
  assert.equal(seen[0].init.body, undefined);
  assert.deepEqual(JSON.parse(seen[1].init.body), { deviceId: 'device-1', changes: [] });
  assert.deepEqual(JSON.parse(seen[2].init.body), { deviceId: 'device-1', limit: 25 });
  assert.equal(seen[1].init.headers.get('content-type'), 'application/json');
});

test('uses a ten-second timeout and passes an abort signal to transport', async () => {
  assert.equal(API_REQUEST_TIMEOUT_MS, 10_000);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduledDelay;
  let signal;

  globalThis.setTimeout = (callback, delay) => {
    scheduledDelay = delay;
    queueMicrotask(callback);
    return 17;
  };
  globalThis.clearTimeout = () => {};

  try {
    const client = clientWith(async (_url, init) => {
      signal = init.signal;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const result = await client.health();

    assert.equal(scheduledDelay, 10_000);
    assert.equal(signal.aborted, true);
    assert.deepEqual(result, {
      state: 'offline',
      status: null,
      error: { code: 'request_timeout', message: 'The local backend did not respond in time.' },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('forwards caller abort without reporting success', async () => {
  const controller = new AbortController();
  const client = clientWith(async (_url, init) => {
    controller.abort();
    return await new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });

  const result = await client.request('/v1/health', { signal: controller.signal });

  assert.deepEqual(result, {
    state: 'failed',
    status: null,
    error: { code: 'request_aborted', message: 'The request was cancelled.' },
  });
});

test('rejects responses larger than one MiB from content-length or streaming bytes', async () => {
  assert.equal(API_MAX_RESPONSE_BYTES, 1024 * 1024);
  const declared = clientWith(
    async () =>
      new Response('{}', {
        headers: {
          ...JSON_HEADERS,
          'content-length': String(API_MAX_RESPONSE_BYTES + 1),
        },
      })
  );
  const streamed = clientWith(async () => {
    const chunk = new Uint8Array(API_MAX_RESPONSE_BYTES / 2 + 1);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: JSON_HEADERS }
    );
  });

  for (const client of [declared, streamed]) {
    assert.deepEqual(await client.health(), {
      state: 'failed',
      status: 200,
      error: { code: 'response_too_large', message: 'The local backend response was too large.' },
    });
  }
});

test('requires a JSON content type and valid JSON without echoing response content', async () => {
  const wrongType = clientWith(
    async () =>
      new Response('<script>secret-value</script>', {
        headers: { 'content-type': 'text/html' },
      })
  );
  const invalidJson = clientWith(
    async () =>
      new Response('secret-value: not-json', {
        headers: JSON_HEADERS,
      })
  );

  assert.deepEqual(await wrongType.health(), {
    state: 'failed',
    status: 200,
    error: { code: 'invalid_content_type', message: 'The local backend returned an invalid response.' },
  });
  const result = await invalidJson.health();
  assert.deepEqual(result, {
    state: 'failed',
    status: 200,
    error: { code: 'invalid_json', message: 'The local backend returned invalid JSON.' },
  });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('maps authentication, conflict, incompatibility, and ordinary HTTP failures explicitly', async () => {
  const cases = [
    [401, 'authentication_required', { code: 'authentication_required', message: 'Authenticate the extension again.' }],
    [409, 'conflict', { code: 'sync_conflict', message: 'The local backend reported a conflict.' }],
    [426, 'incompatible', { code: 'backend_incompatible', message: 'Update Easy Rewind before continuing.' }],
    [500, 'failed', { code: 'request_failed', message: 'The local backend rejected the request.' }],
  ];

  for (const [status, state, error] of cases) {
    const client = clientWith(async () =>
      jsonResponse(
        {
          error: {
            code: 'server_code',
            message: `unsafe server detail with token=server-secret-${status}`,
            details: { apiKey: 'server-secret' },
          },
        },
        { status }
      )
    );
    const result = await client.health();

    assert.deepEqual(result, { state, status, error });
    assert.equal(JSON.stringify(result).includes('server-secret'), false);
  }
});

test('maps transport and authorization failures to bounded credential-free envelopes', async () => {
  const network = clientWith(async () => {
    throw new TypeError('fetch failed for token=network-secret');
  });
  const badAuthorization = clientWith(async () => jsonResponse({ ok: true }), {
    getAuthorization: async () => {
      throw new Error('vault failed for Bearer authorization-secret');
    },
  });

  assert.deepEqual(await network.health(), {
    state: 'offline',
    status: null,
    error: { code: 'backend_offline', message: 'The local backend is unavailable.' },
  });
  const authResult = await badAuthorization.health();
  assert.deepEqual(authResult, {
    state: 'authentication_required',
    status: null,
    error: { code: 'authentication_required', message: 'Authenticate the extension again.' },
  });
  assert.equal(JSON.stringify(authResult).includes('authorization-secret'), false);
});

test('rejects unsafe authorization values before transport and does not expose them', async () => {
  let calls = 0;
  for (const authorization of [
    'session-token-without-scheme',
    'Bearer secret\r\nx-injected: yes',
    'Basic provider-secret',
    { token: 'object-secret' },
  ]) {
    const client = clientWith(
      async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
      { getAuthorization: async () => authorization }
    );
    const result = await client.health();
    assert.equal(result.state, 'authentication_required');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  assert.equal(calls, 0);
});

test('validates constructor dependencies without importing browser globals', () => {
  assert.equal('chrome' in globalThis, false);
  assert.throws(() => createApiClient(), /configuration/);
  assert.throws(
    () =>
      createApiClient({
        baseUrl: 'http://127.0.0.1:3210',
        fetch: null,
        getAuthorization: async () => null,
        now: () => 0,
      }),
    /configuration/
  );
});
