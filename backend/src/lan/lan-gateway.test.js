'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

let createLanGateway;
let createTlsIdentityService;
try {
  ({ createLanGateway } = require('./lan-gateway'));
  ({ createTlsIdentityService } = require('./tls-identity-service'));
} catch {
  // The first TDD run intentionally reaches the assertions below without
  // requiring production files that do not exist yet.
}

const FINGERPRINT = `sha256:${'ab'.repeat(32)}`;
const OTHER_FINGERPRINT = `sha256:${'cd'.repeat(32)}`;

function config(overrides = {}) {
  return {
    enabled: true,
    port: 43_210,
    tlsIdentityRef: 'secret:lan-tls-identity',
    pairingPolicy: { mode: 'explicit-confirmation' },
    allowedSubnetPolicy: { mode: 'private-lan-only' },
    maxBodyBytes: 1_024,
    maxBatchSize: 2,
    requestTimeoutMs: 2_000,
    drainTimeoutMs: 500,
    ...overrides,
  };
}

function createResponse() {
  const headers = new Map();
  let statusCode = 200;
  let body = '';
  return {
    end(chunk = '') {
      body += String(chunk);
    },
    get body() {
      return body;
    },
    get headers() {
      return Object.fromEntries(headers);
    },
    get json() {
      return body === '' ? null : JSON.parse(body);
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), String(value));
    },
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = value;
    },
  };
}

function createRequest({
  method = 'GET',
  url = '/health',
  headers = {},
  body,
  encrypted = true,
  remoteAddress = '192.168.50.25',
  localAddress = '192.168.50.10',
  servername = 'easy-rewind.local',
} = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = {
    host: 'easy-rewind.local:43210',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  request.httpVersionMajor = 1;
  request.socket = { encrypted, localAddress, remoteAddress, servername };
  return request;
}

function createHarness(overrides = {}) {
  const calls = {
    authenticate: [],
    bootstrap: [],
    close: 0,
    create: 0,
    drain: 0,
    listen: [],
    requestTracker: [],
    stopAccepting: 0,
    sync: [],
  };
  let requestHandler;
  const certificateAdapter = {
    async loadIdentity(reference) {
      assert.equal(reference, 'secret:lan-tls-identity');
      return {
        certificate: Buffer.from('certificate'),
        credentialBoundary: 'lan-sync',
        fingerprint: FINGERPRINT,
        privateKey: Buffer.from('private-key'),
        serverName: 'easy-rewind.local',
      };
    },
    inspectIdentity() {
      return {
        fingerprint: FINGERPRINT,
        keyMatches: true,
        validFromMs: 1_000,
        validToMs: 9_000,
      };
    },
    ...overrides.certificateAdapter,
  };
  const server = { protocol: 'https:', secure: true };
  const httpsServerAdapter = {
    async close(receivedServer) {
      assert.equal(receivedServer, server);
      calls.close += 1;
    },
    createSecureServer(options) {
      calls.create += 1;
      requestHandler = options.requestHandler;
      assert.ok(Buffer.isBuffer(options.certificate));
      assert.ok(Buffer.isBuffer(options.privateKey));
      return server;
    },
    async drain(receivedServer, options) {
      assert.equal(receivedServer, server);
      assert.equal(options.timeoutMs, 500);
      calls.drain += 1;
    },
    async listen(receivedServer, address) {
      assert.equal(receivedServer, server);
      calls.listen.push(address);
      return { address: address.host, family: 'IPv4', port: address.port };
    },
    async resolveBindAddress(policy) {
      assert.deepEqual(policy, { mode: 'private-lan-only' });
      return '192.168.50.10';
    },
    async stopAccepting(receivedServer) {
      assert.equal(receivedServer, server);
      calls.stopAccepting += 1;
    },
    ...overrides.httpsServerAdapter,
  };
  const pairingService = {
    async authenticateDevice(input) {
      calls.authenticate.push(input);
      return {
        authenticationType: 'sync_device',
        credentialId: 'credential-1',
        deviceId: 'device-1',
        profileId: 'profile-1',
      };
    },
    async bootstrap(input) {
      calls.bootstrap.push(input);
      return { credential: 'erd_device-1_secret', status: 'paired' };
    },
    ...overrides.pairingService,
  };
  const syncService = {
    async acknowledge(input) {
      calls.sync.push(['acknowledge', input]);
      return { acknowledged: true };
    },
    async pull(input) {
      calls.sync.push(['pull', input]);
      return { changes: [], cursor: 'cursor-1' };
    },
    async push(input) {
      calls.sync.push(['push', input]);
      return { accepted: input.body.operations.length };
    },
    async snapshot(input) {
      calls.sync.push(['snapshot', input]);
      return { records: [], cursor: 'cursor-1' };
    },
    ...overrides.syncService,
  };
  const requestTracker = {
    allow(input) {
      calls.requestTracker.push(input);
      return true;
    },
    ...overrides.requestTracker,
  };
  const gateway = createLanGateway?.({
    certificateAdapter,
    config: config(overrides.config),
    httpsServerAdapter,
    now: () => 5_000,
    pairingService,
    requestTracker,
    syncService,
  });

  async function dispatch(input) {
    assert.equal(typeof requestHandler, 'function');
    const request = createRequest(input);
    const response = createResponse();
    await requestHandler(request, response);
    return response;
  }

  async function dispatchRequest(request) {
    assert.equal(typeof requestHandler, 'function');
    const response = createResponse();
    await requestHandler(request, response);
    return response;
  }

  return {
    calls,
    certificateAdapter,
    dispatch,
    dispatchRequest,
    gateway,
    httpsServerAdapter,
    server,
  };
}

test('exports the LAN gateway and TLS identity constructors', () => {
  assert.equal(typeof createLanGateway, 'function');
  assert.equal(typeof createTlsIdentityService, 'function');
});

test('disabled LAN sync creates no certificate or listener handles', async () => {
  let touched = false;
  const gateway = createLanGateway({
    certificateAdapter: new Proxy(
      {},
      {
        get() {
          touched = true;
        },
      }
    ),
    config: { enabled: false },
    httpsServerAdapter: {},
    pairingService: {},
    requestTracker: {},
    syncService: {},
  });

  await gateway.start();
  await gateway.stop();

  assert.equal(touched, false);
  assert.deepEqual(gateway.health(), { status: 'disabled' });
});

test('starts once on a private address with a distinct valid TLS identity and stops idempotently', async () => {
  const harness = createHarness();

  await Promise.all([harness.gateway.start(), harness.gateway.start()]);
  assert.deepEqual(harness.calls.listen, [{ host: '192.168.50.10', port: 43_210 }]);
  assert.equal(harness.calls.create, 1);
  assert.deepEqual(harness.gateway.health(), { status: 'ready' });

  await Promise.all([harness.gateway.stop(), harness.gateway.stop()]);
  assert.equal(harness.calls.stopAccepting, 1);
  assert.equal(harness.calls.drain, 1);
  assert.equal(harness.calls.close, 1);
  assert.deepEqual(harness.gateway.health(), { status: 'unavailable' });
});

test('TLS identity loading fails closed for missing material, invalid keys, expiry, and fingerprint mismatch', async t => {
  const cases = [
    {
      name: 'missing certificate',
      adapter: {
        loadIdentity: async () => ({ privateKey: Buffer.from('key') }),
        inspectIdentity: () => ({}),
      },
    },
    {
      name: 'key mismatch',
      adapter: {
        loadIdentity: async () => ({
          certificate: Buffer.from('certificate'),
          privateKey: Buffer.from('key'),
        }),
        inspectIdentity: () => ({
          fingerprint: FINGERPRINT,
          keyMatches: false,
          validFromMs: 1_000,
          validToMs: 9_000,
        }),
      },
    },
    {
      name: 'expired certificate',
      adapter: {
        loadIdentity: async () => ({
          certificate: Buffer.from('certificate'),
          privateKey: Buffer.from('key'),
        }),
        inspectIdentity: () => ({
          fingerprint: FINGERPRINT,
          keyMatches: true,
          validFromMs: 1_000,
          validToMs: 4_000,
        }),
      },
    },
    {
      name: 'fingerprint mismatch',
      adapter: {
        loadIdentity: async () => ({
          certificate: Buffer.from('certificate'),
          fingerprint: OTHER_FINGERPRINT,
          privateKey: Buffer.from('key'),
        }),
        inspectIdentity: () => ({
          fingerprint: FINGERPRINT,
          keyMatches: true,
          validFromMs: 1_000,
          validToMs: 9_000,
        }),
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const identityService = createTlsIdentityService({
        certificateAdapter: entry.adapter,
        now: () => 5_000,
      });
      await assert.rejects(identityService.load('secret:identity'), error => {
        assert.equal(error.code, 'LAN_TLS_IDENTITY_INVALID');
        return true;
      });
    });
  }
});

test('rejects non-HTTPS servers and non-private bind addresses before listening', async t => {
  await t.test('non-HTTPS server', async () => {
    const harness = createHarness({
      httpsServerAdapter: {
        createSecureServer() {
          harness.calls.create += 1;
          return { protocol: 'http:', secure: false };
        },
      },
    });
    await assert.rejects(harness.gateway.start(), error => {
      assert.equal(error.code, 'LAN_TLS_REQUIRED');
      return true;
    });
    assert.deepEqual(harness.calls.listen, []);
  });

  await t.test('public bind address', async () => {
    const harness = createHarness({
      httpsServerAdapter: { resolveBindAddress: async () => '203.0.113.10' },
    });
    await assert.rejects(harness.gateway.start(), error => {
      assert.equal(error.code, 'LAN_BIND_ADDRESS_FORBIDDEN');
      return true;
    });
    assert.equal(harness.calls.create, 0);
  });
});

test('serves only a sanitized health response on an encrypted allowed request', async () => {
  const harness = createHarness();
  await harness.gateway.start();

  const response = await harness.dispatch();

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { protocolVersion: '1', status: 'ok' });
  assert.deepEqual(Object.keys(response.json).sort(), ['protocolVersion', 'status']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});

test('rejects plaintext, public sources, wrong Host, and wrong SNI before route handling', async t => {
  const cases = [
    { name: 'plaintext', input: { encrypted: false }, status: 426, code: 'tls_required' },
    {
      name: 'public source',
      input: { remoteAddress: '198.51.100.3' },
      status: 403,
      code: 'source_forbidden',
    },
    {
      name: 'wrong Host',
      input: { headers: { host: 'attacker.example:43210' } },
      status: 421,
      code: 'host_mismatch',
    },
    {
      name: 'wrong SNI',
      input: { servername: 'attacker.example' },
      status: 421,
      code: 'host_mismatch',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = createHarness();
      await harness.gateway.start();
      const response = await harness.dispatch(entry.input);
      assert.equal(response.statusCode, entry.status);
      assert.equal(response.json.error.code, entry.code);
      assert.equal(harness.calls.bootstrap.length, 0);
      assert.equal(harness.calls.authenticate.length, 0);
    });
  }
});

test('rejects traversal, proxy, absolute-form, and protocol-upgrade attempts', async t => {
  const attempts = [
    { url: '/v1/sync/%2e%2e/health' },
    { url: 'https://easy-rewind.local/v1/sync/pull' },
    { url: '/v1\\sync\\pull' },
    { headers: { forwarded: 'for=192.168.50.25' } },
    { headers: { 'x-forwarded-host': 'easy-rewind.local' } },
    { headers: { connection: 'upgrade', upgrade: 'websocket' } },
  ];
  for (const input of attempts) {
    await t.test(JSON.stringify(input), async () => {
      const harness = createHarness();
      await harness.gateway.start();
      const response = await harness.dispatch(input);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json.error.code, 'invalid_request_target');
    });
  }
});

test('pairing bootstrap is the only unauthenticated application endpoint', async () => {
  const harness = createHarness();
  await harness.gateway.start();

  const response = await harness.dispatch({
    body: { challengeId: 'challenge-1', installationId: 'installation-1' },
    method: 'POST',
    url: '/v1/pairing/bootstrap',
  });
  const hidden = await harness.dispatch({ url: '/' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { credential: 'erd_device-1_secret', status: 'paired' });
  assert.equal(harness.calls.bootstrap[0].tlsFingerprint, FINGERPRINT);
  assert.equal(hidden.statusCode, 404);
  assert.equal(hidden.json.error.code, 'not_found');
});

test('authenticated sync routes accept only device credentials and pass authenticated ownership', async t => {
  const routes = [
    {
      method: 'POST',
      url: '/v1/sync/push',
      body: { operations: [{ idempotencyKey: 'one' }] },
      operation: 'push',
    },
    { method: 'GET', url: '/v1/sync/pull?cursor=cursor-0', operation: 'pull' },
    {
      method: 'POST',
      url: '/v1/sync/acknowledge',
      body: { cursor: 'cursor-1' },
      operation: 'acknowledge',
    },
    { method: 'GET', url: '/v1/sync/snapshot', operation: 'snapshot' },
  ];
  for (const route of routes) {
    await t.test(route.operation, async () => {
      const harness = createHarness();
      await harness.gateway.start();
      const response = await harness.dispatch({
        ...route,
        headers: { authorization: 'Bearer erd_device-1_secret' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(harness.calls.authenticate[0].authorization, 'Bearer erd_device-1_secret');
      assert.equal(harness.calls.authenticate[0].transport, 'lan');
      const [operation, input] = harness.calls.sync[0];
      assert.equal(operation, route.operation);
      assert.equal(input.auth.deviceId, 'device-1');
      assert.equal(input.auth.profileId, 'profile-1');
    });
  }
});

test('rejects loopback credentials and revoked or unpaired devices', async t => {
  const cases = [
    {
      name: 'loopback install bearer',
      authorization: 'Bearer eri_install-1.secret',
      error: Object.assign(new Error('invalid'), { code: 'AUTH_BEARER_INVALID' }),
      status: 401,
      code: 'device_credential_invalid',
    },
    {
      name: 'revoked device',
      authorization: 'Bearer erd_device-1_secret',
      error: Object.assign(new Error('revoked'), { code: 'AUTH_DEVICE_REVOKED' }),
      status: 403,
      code: 'device_revoked',
    },
    {
      name: 'unpaired device',
      authorization: 'Bearer erd_device-2_secret',
      error: Object.assign(new Error('invalid'), { code: 'AUTH_BEARER_INVALID' }),
      status: 401,
      code: 'device_credential_invalid',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = createHarness({
        pairingService: {
          async authenticateDevice() {
            throw entry.error;
          },
        },
      });
      await harness.gateway.start();
      const response = await harness.dispatch({
        headers: { authorization: entry.authorization },
        url: '/v1/sync/pull',
      });
      assert.equal(response.statusCode, entry.status);
      assert.equal(response.json.error.code, entry.code);
      assert.equal(harness.calls.sync.length, 0);
    });
  }
});

test('enforces request rate, body, content-type, and sync batch bounds', async t => {
  await t.test('rate limit', async () => {
    const harness = createHarness({ requestTracker: { allow: () => false } });
    await harness.gateway.start();
    const response = await harness.dispatch({ url: '/health' });
    assert.equal(response.statusCode, 429);
    assert.equal(response.json.error.code, 'rate_limited');
  });

  await t.test('body byte limit', async () => {
    const harness = createHarness({ config: { maxBodyBytes: 8 } });
    await harness.gateway.start();
    const response = await harness.dispatch({
      body: { challengeId: 'too-large' },
      method: 'POST',
      url: '/v1/pairing/bootstrap',
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json.error.code, 'request_too_large');
  });

  await t.test('request timeout', async () => {
    const harness = createHarness({ config: { requestTimeoutMs: 1 } });
    await harness.gateway.start();
    const request = new Readable({ read() {} });
    request.headers = {
      'content-type': 'application/json',
      host: 'easy-rewind.local:43210',
    };
    request.httpVersionMajor = 1;
    request.method = 'POST';
    request.url = '/v1/pairing/bootstrap';
    request.socket = {
      encrypted: true,
      localAddress: '192.168.50.10',
      remoteAddress: '192.168.50.25',
      servername: 'easy-rewind.local',
    };
    const response = await harness.dispatchRequest(request);
    assert.equal(response.statusCode, 408);
    assert.equal(response.json.error.code, 'request_timed_out');
  });

  await t.test('JSON content type', async () => {
    const harness = createHarness();
    await harness.gateway.start();
    const response = await harness.dispatch({
      body: '{}',
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
      url: '/v1/pairing/bootstrap',
    });
    assert.equal(response.statusCode, 415);
    assert.equal(response.json.error.code, 'content_type_invalid');
  });

  await t.test('batch limit', async () => {
    const harness = createHarness();
    await harness.gateway.start();
    const response = await harness.dispatch({
      body: { operations: [{}, {}, {}] },
      headers: { authorization: 'Bearer erd_device-1_secret' },
      method: 'POST',
      url: '/v1/sync/push',
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json.error.code, 'batch_too_large');
    assert.equal(harness.calls.sync.length, 0);
  });
});
