import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_MAX_RESPONSE_BYTES,
  API_REQUEST_TIMEOUT_MS,
  createDashboardApiClient,
  normalizeApiOrigin,
  normalizeApiUrl,
} from '../js/api-client.js';
import { createDashboardSession } from '../js/session.js';

const PROFILE_ID = 'profile-owner';
const TOKEN = 'install-authorization-value';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function memoryStorage() {
  const values = new Map();
  const calls = [];
  return {
    calls,
    getItem(key) {
      calls.push(['get', key]);
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(['set', key, value]);
      values.set(key, value);
    },
    removeItem(key) {
      calls.push(['remove', key]);
      values.delete(key);
    },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: JSON_HEADERS,
    ...init,
  });
}

function establishedSession() {
  return {
    async read() {
      return { authorization: TOKEN, profileId: PROFILE_ID };
    },
  };
}

function createClient(fetch, overrides = {}) {
  return createDashboardApiClient({
    fetch,
    location: { origin: 'http://127.0.0.1:3210' },
    session: establishedSession(),
    scheduleTimeout: globalThis.setTimeout,
    cancelTimeout: globalThis.clearTimeout,
    ...overrides,
  });
}

test('session authorization and profile binding live only in injected sessionStorage', async () => {
  const sessionStorage = memoryStorage();
  const localStorage = new Proxy(
    {},
    {
      get() {
        throw new Error('localStorage must not be touched');
      },
    }
  );
  const session = createDashboardSession({ sessionStorage, localStorage });

  await session.establish({ authorization: TOKEN, profileId: PROFILE_ID });
  assert.deepEqual(await session.read(), { authorization: TOKEN, profileId: PROFILE_ID });
  assert.equal(
    sessionStorage.calls.some(call => call[0] === 'set'),
    true
  );
  assert.equal(JSON.stringify(sessionStorage.calls).includes(TOKEN), true);

  await session.clear();
  assert.equal(await session.read(), null);
  assert.equal('authorization' in session, false);
});

test('missing or malformed session authorization fails before transport', async () => {
  let fetchCalls = 0;
  for (const session of [
    { async read() {} },
    {
      async read() {
        return { authorization: '', profileId: PROFILE_ID };
      },
    },
    {
      async read() {
        return { authorization: 'bad\r\nheader', profileId: PROFILE_ID };
      },
    },
    {
      async read() {
        return { authorization: TOKEN, profileId: '' };
      },
    },
  ]) {
    const client = createClient(
      async () => {
        fetchCalls += 1;
        return jsonResponse({ ok: true });
      },
      { session }
    );
    assert.deepEqual(await client.request('/v1/items'), {
      state: 'authentication_required',
      status: null,
      error: {
        code: 'authentication_required',
        message: 'Authenticate to Easy Rewind again.',
      },
    });
  }
  assert.equal(fetchCalls, 0);
});

test('derives the API origin from location and allows only exact HTTP or HTTPS loopback origins', () => {
  for (const origin of [
    'http://127.0.0.1:3210',
    'https://127.0.0.1:3210',
    'http://localhost:3210',
    'https://localhost',
  ]) {
    assert.equal(normalizeApiOrigin(origin), new URL(origin).origin);
  }
  for (const origin of [
    'file:///dashboard.html',
    'https://example.com',
    'http://127.0.0.2:3210',
    'http://localhost.example:3210',
    'http://user:password@localhost:3210',
    'http://localhost:3210/api',
    'http://localhost:3210/?token=value',
    'http://localhost:3210/#fragment',
  ]) {
    assert.throws(() => normalizeApiOrigin(origin), /loopback origin/);
  }

  const client = createClient(async () => jsonResponse({ ok: true }), {
    location: { origin: 'https://localhost:4443' },
  });
  assert.equal(client.origin, 'https://localhost:4443');
});

test('normalizes only same-origin credential-free and profile-free API paths', () => {
  assert.equal(
    normalizeApiUrl('http://127.0.0.1:3210', '/v1/items?limit=25'),
    'http://127.0.0.1:3210/v1/items?limit=25'
  );
  for (const path of [
    'v1/items',
    '//example.com/v1/items',
    'https://example.com/v1/items',
    '/v1/items#fragment',
    '/v1/items?token=value',
    '/v1/items?api_key=value',
    '/v1/items?profileId=other',
    '/v1/items?profile_id=other',
    '/v1/items\u0000',
  ]) {
    assert.throws(() => normalizeApiUrl('http://127.0.0.1:3210', path), /safe API path/);
  }
});

test('every protected request carries Bearer authorization without URL or caller-header leakage', async () => {
  const seen = [];
  const client = createClient(async (url, init) => {
    seen.push({ url, init });
    return jsonResponse({ profileId: PROFILE_ID, items: [] });
  });

  const result = await client.request('/v1/items?limit=10', {
    headers: {
      authorization: 'Bearer attacker',
      'x-user-id': 'attacker',
      'x-profile-id': 'attacker',
    },
  });

  assert.equal(result.state, 'ready');
  assert.equal(seen[0].init.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(seen[0].init.headers.has('x-user-id'), false);
  assert.equal(seen[0].init.headers.has('x-profile-id'), false);
  assert.equal(seen[0].url.includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('request bodies cannot override the authenticated profile boundary', async () => {
  let fetchCalls = 0;
  const client = createClient(async () => {
    fetchCalls += 1;
    return jsonResponse({ ok: true });
  });

  for (const body of [
    { profileId: 'other' },
    { nested: { profile_id: 'other' } },
    [{ safe: true }, { ownerProfileId: 'other' }],
  ]) {
    await assert.rejects(() => client.request('/v1/items', { method: 'POST', body }), /profile ownership/);
  }
  assert.equal(fetchCalls, 0);
});

test('response profile contradictions fail closed without returning hostile data', async () => {
  const client = createClient(async () =>
    jsonResponse({
      items: [
        { id: 'safe', profile_id: PROFILE_ID },
        { id: 'hostile', profileId: 'profile-other', title: '<script>hostile</script>' },
      ],
    })
  );

  const result = await client.request('/v1/items');

  assert.deepEqual(result, {
    state: 'failed',
    status: 200,
    error: {
      code: 'profile_isolation_violation',
      message: 'The local backend returned data for a different profile.',
    },
  });
  assert.equal(JSON.stringify(result).includes('hostile'), false);
});

test('uses an injected bounded timeout and never reports a timed-out request as successful', async () => {
  assert.equal(API_REQUEST_TIMEOUT_MS, 10_000);
  let scheduledDelay;
  let scheduledCallback;
  let signal;
  const client = createClient(
    async (_url, init) => {
      signal = init.signal;
      scheduledCallback();
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    {
      scheduleTimeout(callback, delay) {
        scheduledCallback = callback;
        scheduledDelay = delay;
        return 7;
      },
      cancelTimeout() {},
    }
  );

  assert.deepEqual(await client.request('/v1/items'), {
    state: 'offline',
    status: null,
    error: {
      code: 'request_timeout',
      message: 'The local backend did not respond in time.',
    },
  });
  assert.equal(scheduledDelay, 10_000);
  assert.equal(signal.aborted, true);
});

test('rejects non-JSON, invalid JSON, and oversized responses with bounded safe errors', async () => {
  assert.equal(API_MAX_RESPONSE_BYTES, 1024 * 1024);
  const clients = [
    [
      createClient(async () => new Response('<script>secret</script>', { headers: { 'content-type': 'text/html' } })),
      'invalid_content_type',
    ],
    [createClient(async () => new Response('secret invalid JSON', { headers: JSON_HEADERS })), 'invalid_json'],
    [
      createClient(
        async () =>
          new Response('{}', {
            headers: {
              ...JSON_HEADERS,
              'content-length': String(API_MAX_RESPONSE_BYTES + 1),
            },
          })
      ),
      'response_too_large',
    ],
  ];

  for (const [client, code] of clients) {
    const result = await client.request('/v1/items');
    assert.equal(result.state, 'failed');
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('maps protected HTTP and transport failures to stable credential-free states', async () => {
  const cases = [
    [401, 'authentication_required', 'authentication_required'],
    [403, 'authentication_required', 'authentication_required'],
    [409, 'conflict', 'conflict'],
    [426, 'incompatible', 'backend_incompatible'],
    [500, 'failed', 'request_failed'],
  ];
  for (const [status, state, code] of cases) {
    const client = createClient(async () => jsonResponse({ error: { message: `unsafe ${TOKEN}` } }, { status }));
    const result = await client.request('/v1/items');
    assert.equal(result.state, state);
    assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }

  const offline = createClient(async () => {
    throw new TypeError(`network failed ${TOKEN}`);
  });
  assert.equal((await offline.request('/v1/items')).state, 'offline');
});
