'use strict';

const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const test = require('node:test');

const { RemoteFetchError, createRemoteFetcher } = require('./remote-fetch');
const { sanitizeHtml } = require('./html-sanitizer');
const { assertSafeRemoteUrl } = require('./url-policy');

const PUBLIC_V4 = '93.184.216.34';

function response({ statusCode = 200, headers = { 'content-type': 'text/plain; charset=utf-8' }, body = 'ok' } = {}) {
  return {
    statusCode,
    headers,
    body: Buffer.isBuffer(body) ? [body] : [Buffer.from(body)],
  };
}

function createManualClock() {
  let nextId = 1;
  const timers = new Map();

  return {
    clock: {
      now: () => 0,
      setTimeout(callback, delay) {
        const id = nextId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    fireDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.notEqual(entry, undefined, `expected an active ${delay}ms timer`);
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
    },
  };
}

function createFetcher(overrides = {}) {
  return createRemoteFetcher({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    request: async () => response(),
    ...overrides,
  });
}

async function assertRemoteError(action, expectedCode) {
  await assert.rejects(action, error => {
    assert.equal(error instanceof RemoteFetchError, true);
    assert.equal(error.code, expectedCode);
    assert.equal(typeof error.message, 'string');
    assert.equal(error.message.length > 0, true);
    return true;
  });
}

test('accepts only http and https URLs', () => {
  assert.throws(
    () => assertSafeRemoteUrl('file:///private.txt'),
    error => error instanceof RemoteFetchError && error.code === 'REMOTE_SCHEME_UNSUPPORTED'
  );
});

test('rejects URL credentials', () => {
  assert.throws(
    () => assertSafeRemoteUrl('https://user:password@example.test/'),
    error => error instanceof RemoteFetchError && error.code === 'REMOTE_URL_CREDENTIALS'
  );
});

test('rejects localhost names without DNS lookup', async () => {
  let lookupCalls = 0;
  const fetcher = createFetcher({
    lookup: async () => {
      lookupCalls += 1;
      return [{ address: PUBLIC_V4, family: 4 }];
    },
  });

  await assertRemoteError(() => fetcher.fetch('http://service.localhost/'), 'REMOTE_ADDRESS_BLOCKED');
  assert.equal(lookupCalls, 0);
});

test('rejects private link-local multicast reserved and documentation IPv4 literals', async () => {
  const fetcher = createFetcher();
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];

  for (const address of blocked) {
    await assertRemoteError(() => fetcher.fetch(`http://${address}/`), 'REMOTE_ADDRESS_BLOCKED');
  }
});

test('rejects alternate IPv4 representations after URL normalization', async () => {
  const fetcher = createFetcher();

  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/']) {
    await assertRemoteError(() => fetcher.fetch(url), 'REMOTE_ADDRESS_BLOCKED');
  }
});

test('rejects IPv6 loopback link-local unique-local multicast documentation and mapped IPv4', async () => {
  const fetcher = createFetcher();
  const blocked = ['::1', 'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1'];

  for (const address of blocked) {
    await assertRemoteError(() => fetcher.fetch(`http://[${address}]/`), 'REMOTE_ADDRESS_BLOCKED');
  }
});

test('checks every DNS answer and rejects a mixed public-private result', async () => {
  let requestCalls = 0;
  const fetcher = createFetcher({
    lookup: async () => [
      { address: PUBLIC_V4, family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
    request: async () => {
      requestCalls += 1;
      return response();
    },
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/'), 'REMOTE_ADDRESS_BLOCKED');
  assert.equal(requestCalls, 0);
});

test('pins the request address while preserving TLS server name and HTTP host', async () => {
  let observed;
  const fetcher = createFetcher({
    request: async options => {
      observed = options;
      return response();
    },
  });

  const result = await fetcher.fetch('https://example.test:8443/path?q=1');

  assert.equal(observed.hostname, PUBLIC_V4);
  assert.equal(observed.servername, 'example.test');
  assert.equal(observed.headers.host, 'example.test:8443');
  assert.equal(observed.path, '/path?q=1');
  assert.equal(observed.protocol, 'https:');
  assert.deepEqual(result, {
    statusCode: 200,
    contentType: 'text/plain',
    body: 'ok',
    redirectCount: 0,
  });
});

test('revalidates redirects before a second request', async () => {
  let requestCalls = 0;
  const fetcher = createFetcher({
    request: async () => {
      requestCalls += 1;
      return response({
        statusCode: 302,
        headers: { location: 'http://127.0.0.1/private' },
        body: '',
      });
    },
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/start'), 'REMOTE_ADDRESS_BLOCKED');
  assert.equal(requestCalls, 1);
});

test('rejects redirect loops', async () => {
  const fetcher = createFetcher({
    request: async options =>
      response({
        statusCode: 302,
        headers: {
          location: options.path === '/a' ? 'https://example.test/b' : 'https://example.test/a',
        },
        body: '',
      }),
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/a'), 'REMOTE_REDIRECT_LOOP');
});

test('enforces the redirect count', async () => {
  const fetcher = createFetcher({
    limits: { maxRedirects: 1 },
    request: async options =>
      response({
        statusCode: 302,
        headers: {
          location: options.path === '/a' ? 'https://example.test/b' : 'https://example.test/c',
        },
        body: '',
      }),
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/a'), 'REMOTE_REDIRECT_LIMIT');
});

test('enforces the connection timeout with the injected clock', async () => {
  const manual = createManualClock();
  let requestStarted;
  const started = new Promise(resolve => {
    requestStarted = resolve;
  });
  const fetcher = createFetcher({
    clock: manual.clock,
    limits: { connectTimeoutMs: 25, totalTimeoutMs: 100 },
    request: async () => {
      requestStarted();
      return new Promise(() => {});
    },
  });

  const pending = fetcher.fetch('https://example.test/');
  await started;
  manual.fireDelay(25);
  await assertRemoteError(() => pending, 'REMOTE_CONNECT_TIMEOUT');
});

test('enforces the total timeout while reading a response body', async () => {
  const manual = createManualClock();
  let bodyStarted;
  const started = new Promise(resolve => {
    bodyStarted = resolve;
  });
  const fetcher = createFetcher({
    clock: manual.clock,
    limits: { connectTimeoutMs: 25, totalTimeoutMs: 100 },
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: {
        async *[Symbol.asyncIterator]() {
          bodyStarted();
          await new Promise(() => {});
        },
      },
    }),
  });

  const pending = fetcher.fetch('https://example.test/');
  await started;
  manual.fireDelay(100);
  await assertRemoteError(() => pending, 'REMOTE_TOTAL_TIMEOUT');
});

test('rejects encoded bodies beyond the compressed byte bound', async () => {
  const fetcher = createFetcher({
    limits: { maxCompressedBytes: 7, maxDecodedBytes: 64 },
    request: async () => response({ body: Buffer.from('12345678') }),
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/'), 'REMOTE_COMPRESSED_TOO_LARGE');
});

test('rejects decompressed bodies beyond the decoded byte bound', async () => {
  const compressed = gzipSync(Buffer.alloc(128, 65));
  const fetcher = createFetcher({
    limits: { maxCompressedBytes: 1024, maxDecodedBytes: 32 },
    request: async () =>
      response({
        headers: {
          'content-type': 'text/plain',
          'content-encoding': 'gzip',
        },
        body: compressed,
      }),
  });

  await assertRemoteError(() => fetcher.fetch('https://example.test/'), 'REMOTE_DECODED_TOO_LARGE');
});

test('rejects missing and disallowed content types', async () => {
  const missing = createFetcher({
    request: async () => response({ headers: {} }),
  });
  const disallowed = createFetcher({
    request: async () => response({ headers: { 'content-type': 'application/octet-stream' } }),
  });

  await assertRemoteError(() => missing.fetch('https://example.test/'), 'REMOTE_CONTENT_TYPE_INVALID');
  await assertRemoteError(() => disallowed.fetch('https://example.test/'), 'REMOTE_CONTENT_TYPE_UNSUPPORTED');
});

test('rejects malformed response objects', async () => {
  const invalidStatus = createFetcher({
    request: async () => ({ statusCode: '200', headers: {}, body: [] }),
  });
  const invalidBody = createFetcher({
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      body: 42,
    }),
  });

  await assertRemoteError(() => invalidStatus.fetch('https://example.test/'), 'REMOTE_RESPONSE_INVALID');
  await assertRemoteError(() => invalidBody.fetch('https://example.test/'), 'REMOTE_RESPONSE_INVALID');
});

test('sanitizes HTML without executable elements attributes or loading remote resources', async () => {
  const unsafe =
    '<h1 onclick="steal()">Title</h1><script>steal()</script><a href="javascript:steal()">go</a>' +
    '<img src="https://tracker.test/pixel" onerror="steal()" alt="pixel"><p>safe</p>';
  const fetcher = createFetcher({
    request: async () =>
      response({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: unsafe,
      }),
  });

  const result = await fetcher.fetch('https://example.test/');

  assert.equal(result.contentType, 'text/html');
  assert.match(result.body, /<h1>Title<\/h1>/);
  assert.match(result.body, /<p>safe<\/p>/);
  assert.doesNotMatch(result.body, /script|onclick|javascript:|tracker\.test|onerror/i);
});

test('the standalone sanitizer neutralizes malformed and encoded unsafe markup', () => {
  const sanitized = sanitizeHtml(
    '<svg><a href="&#106;avascript:alert(1)">x</a></svg><p title="ok" style="color:red">safe</p>'
  );

  assert.equal(sanitized, '<p title="ok">safe</p>');
});

test('returns only controlled request errors without leaking URL address hostname or content', async () => {
  const secrets = ['private.example.test', '93.184.216.34', 'sensitive-content'];
  const fetcher = createFetcher({
    request: async () => {
      throw new Error(`https://${secrets[0]}/ ${secrets[1]} ${secrets[2]}`);
    },
  });

  await assert.rejects(
    () => fetcher.fetch(`https://${secrets[0]}/sensitive-content`),
    error => {
      assert.equal(error instanceof RemoteFetchError, true);
      assert.equal(error.code, 'REMOTE_REQUEST_FAILED');
      const serialized = JSON.stringify({ name: error.name, code: error.code, message: error.message });
      for (const secret of secrets) assert.equal(serialized.includes(secret), false);
      return true;
    }
  );
});
