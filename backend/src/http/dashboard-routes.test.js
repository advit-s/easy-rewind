'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const supertest = require('supertest');

const { createApp } = require('./create-app');
const { DASHBOARD_ASSETS } = require('./dashboard-routes');

const HEALTH = Object.freeze({
  status: 'ok',
  version: '2.0.0',
  schemaVersion: 3,
  apiVersion: '1',
  mode: 'test',
  components: {
    database: { status: 'ready' },
    applicationApi: { status: 'ready' },
    scheduler: { status: 'disabled' },
    lanSync: { status: 'disabled' },
  },
});
const INSTALL_TOKEN = 'install-token-must-never-appear-in-dashboard';
const JAVASCRIPT_ASSETS = Object.freeze([
  'api-client.js',
  'dashboard.js',
  'dom.js',
  'graph-renderer.js',
  'session.js',
  'view-models.js',
]);

async function dashboardFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'easy-rewind-dashboard-routes-'));
  await Promise.all([
    mkdir(path.join(root, 'styles'), { recursive: true }),
    mkdir(path.join(root, 'js'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(root, 'dashboard.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="/styles/dashboard.css"></head><body>Dashboard<script src="/js/dashboard.js"></script></body></html>',
      'utf8'
    ),
    writeFile(path.join(root, 'styles', 'dashboard.css'), 'body { color: #111; }\n', 'utf8'),
    ...JAVASCRIPT_ASSETS.map(fileName =>
      writeFile(path.join(root, 'js', fileName), `export const moduleName = '${fileName}';\n`, 'utf8')
    ),
    writeFile(path.join(root, 'secret.txt'), INSTALL_TOKEN, 'utf8'),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function appWith(dashboardDirectory, routeDependencies = {}) {
  return createApp({
    health: async () => HEALTH,
    generateRequestId: () => 'request_dashboard_routes_0001',
    dashboardDirectory,
    routeDependencies,
  });
}

function assertDashboardSecurityHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.pragma, 'no-cache');
  assert.equal(response.headers.expires, '0');
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers['last-modified'], undefined);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.match(response.headers['permissions-policy'], /camera=\(\)/);
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
}

test('serves only the dashboard shell and its exact external assets for GET and HEAD', async t => {
  const dashboardDirectory = await dashboardFixture(t);
  const app = appWith(dashboardDirectory);

  const shell = await supertest(app).get('/dashboard').expect(200);
  assert.match(shell.headers['content-type'], /^text\/html;\s*charset=utf-8$/i);
  assert.match(shell.text, /\/styles\/dashboard\.css/);
  assert.match(shell.text, /\/js\/dashboard\.js/);
  assertDashboardSecurityHeaders(shell);

  const css = await supertest(app).get('/styles/dashboard.css').expect(200);
  assert.match(css.headers['content-type'], /^text\/css;\s*charset=utf-8$/i);
  assert.equal(css.text, 'body { color: #111; }\n');
  assertDashboardSecurityHeaders(css);

  for (const fileName of JAVASCRIPT_ASSETS) {
    const javascript = await supertest(app).get(`/js/${fileName}`).expect(200);
    assert.equal(javascript.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(javascript.text, `export const moduleName = '${fileName}';\n`);
    assertDashboardSecurityHeaders(javascript);

    const javascriptHead = await supertest(app).head(`/js/${fileName}`).expect(200);
    assert.equal(javascriptHead.text, undefined);
    assert.equal(Number(javascriptHead.headers['content-length']), Buffer.byteLength(javascript.text));
    assertDashboardSecurityHeaders(javascriptHead);
  }

  const shellHead = await supertest(app).head('/dashboard').expect(200);
  assert.equal(shellHead.text, undefined);
  assert.equal(Number(shellHead.headers['content-length']), Buffer.byteLength(shell.text));
  assertDashboardSecurityHeaders(shellHead);
});

test('exports the complete frozen static asset allowlist', () => {
  assert.deepEqual(Object.keys(DASHBOARD_ASSETS).sort(), [
    '/dashboard',
    '/js/api-client.js',
    '/js/dashboard.js',
    '/js/dom.js',
    '/js/graph-renderer.js',
    '/js/session.js',
    '/js/view-models.js',
    '/styles/dashboard.css',
  ]);
  assert.equal(Object.isFrozen(DASHBOARD_ASSETS), true);
  for (const asset of Object.values(DASHBOARD_ASSETS)) {
    assert.equal(Object.isFrozen(asset), true);
    assert.equal(Object.isFrozen(asset.relativePath), true);
  }
});

test('rejects traversal, directory discovery, unallowlisted assets, and non-read methods', async t => {
  const dashboardDirectory = await dashboardFixture(t);
  const app = appWith(dashboardDirectory);

  for (const target of [
    '/dashboard/',
    '/dashboard/index.html',
    '/dashboard/assets',
    '/styles/',
    '/styles/other.css',
    '/js/',
    '/js/unknown.js',
    '/js/dashboard.js.map',
    '/js/api-client',
    '/js/nested/dashboard.js',
    '/secret.txt',
    '/styles/../secret.txt',
    '/styles/%2e%2e/secret.txt',
    '/js/%2e%2e%2fsecret.txt',
  ]) {
    const response = await supertest(app).get(target).expect(404);
    assert.equal(response.body.error.code, 'not_found', target);
    assert.equal(JSON.stringify(response.body).includes(dashboardDirectory), false, target);
    assert.equal(JSON.stringify(response.body).includes(INSTALL_TOKEN), false, target);
  }

  await supertest(app).post('/dashboard').send({ value: true }).expect(404);
  await supertest(app).put('/styles/dashboard.css').send({ value: true }).expect(404);
});

test('dashboard files are public but API authentication and token isolation remain unchanged', async t => {
  const dashboardDirectory = await dashboardFixture(t);
  let authenticationCalls = 0;
  const app = appWith(dashboardDirectory, {
    installTokenService: {
      token: INSTALL_TOKEN,
      async authenticate() {
        authenticationCalls += 1;
        throw new Error('Static dashboard routes must not authenticate or read install credentials.');
      },
    },
    localAuthMiddleware(_request, _response, next) {
      next();
    },
  });

  const shell = await supertest(app).get('/dashboard').expect(200);
  assert.equal(authenticationCalls, 0);
  assert.equal(shell.text.includes(INSTALL_TOKEN), false);

  const api = await supertest(app).get('/api/items').expect(401);
  assert.equal(api.body.error.code, 'auth_required');
});

test('missing dashboard files fail safely without path or directory disclosure', async t => {
  const dashboardDirectory = await dashboardFixture(t);
  await rm(path.join(dashboardDirectory, 'dashboard.html'));

  const missing = await supertest(appWith(dashboardDirectory)).get('/dashboard').expect(404);
  assert.equal(missing.body.error.code, 'not_found');
  assert.equal(JSON.stringify(missing.body).includes(dashboardDirectory), false);
  assert.equal(JSON.stringify(missing.body).includes('dashboard.html'), false);
});

test('absent dashboard configuration preserves existing routes and invalid directories fail at composition', async () => {
  await supertest(appWith(undefined)).get('/dashboard').expect(404);
  await supertest(appWith(undefined)).get('/v1/health').expect(200);

  for (const dashboardDirectory of [null, '', 'frontend', 42, {}, []]) {
    assert.throws(() => appWith(dashboardDirectory), {
      name: 'TypeError',
      message: 'Dashboard directory is invalid',
    });
  }
});

test('valid dashboard configuration does not mask unrelated application dependency errors', async t => {
  const dashboardDirectory = await dashboardFixture(t);
  assert.throws(
    () =>
      createApp({
        health: null,
        dashboardDirectory,
      }),
    {
      name: 'TypeError',
      message: 'HTTP application dependencies are invalid',
    }
  );
});
