import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');

async function source(relativePath) {
  return readFile(path.join(frontendRoot, relativePath), 'utf8');
}

test('dashboard shell uses only external local CSS and JavaScript under a strict loopback CSP', async () => {
  const [html, css, javascript] = await Promise.all([
    source('dashboard.html'),
    source('styles/dashboard.css'),
    source('js/dashboard.js'),
  ]);

  assert.match(html, /<link[^>]+href="\/styles\/dashboard\.css"[^>]*>/i);
  assert.match(html, /<script[^>]+type="module"[^>]+src="\/js\/dashboard\.js"[^>]*><\/script>/i);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);

  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/i)?.[1];
  assert.ok(csp, 'dashboard must declare a Content Security Policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/i);

  assert.doesNotMatch(`${html}\n${css}\n${javascript}`, /fonts\.googleapis|fonts\.gstatic|@import\s+url/i);
});

test('dashboard source has no inline event handlers or style attributes', async () => {
  const [html, javascript] = await Promise.all([source('dashboard.html'), source('js/dashboard.js')]);
  const combined = `${html}\n${javascript}`;

  assert.doesNotMatch(combined, /\sstyle\s*=/i);
  assert.doesNotMatch(combined, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(javascript, /\.on(?:click|change|input|submit|keydown)\s*=/i);
  assert.match(javascript, /addEventListener\(/);
  assert.match(javascript, /data-action/);
});

test('dashboard derives its API root from the page origin without a fixed host or port', async () => {
  const javascript = await source('js/dashboard.js');

  assert.match(javascript, /createDashboardApiClient/);
  assert.doesNotMatch(javascript, /https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  assert.doesNotMatch(javascript, /localhost:\d+|127\.0\.0\.1:\d+/i);
});

test('dashboard uses the authenticated session, API, view-model, graph, and safe DOM modules', async () => {
  const javascript = await source('js/dashboard.js');

  for (const module of ['./session.js', './api-client.js', './dom.js', './view-models.js', './graph-renderer.js']) {
    assert.match(javascript, new RegExp(`from ['"]${module.replace('.', '\\.')}['"]`));
  }
  assert.doesNotMatch(
    javascript,
    /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|DOMParser|document\.write|\beval\s*\(/
  );
  assert.doesNotMatch(javascript, /\blocalStorage\b|x-user-id|\/api\/session|Math\.random/);
  assert.doesNotMatch(javascript, /\bfetch\s*\(|window\.open\s*\(|\bconfirm\s*\(/);
  assert.match(javascript, /\.request\(['"`]\/api\//);
});

test('dashboard exposes an accessible session-only connection and recovery panel', async () => {
  const html = await source('dashboard.html');

  for (const id of [
    'connection-panel',
    'session-form',
    'session-profile-id',
    'session-authorization',
    'session-connect-btn',
    'session-disconnect-btn',
    'session-retry-btn',
    'connection-status',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /id="session-authorization"[^>]+type="password"/);
  assert.doesNotMatch(html, /id="session-authorization"[^>]+\bvalue=/);
  assert.match(html, /id="connection-status"[^>]+role="status"/);
  assert.match(html, /aria-live="polite"/);
});

test('all existing dashboard navigation panels and workflow actions remain represented', async () => {
  const html = await source('dashboard.html');

  for (const panel of ['bookmarks', 'memory', 'notes', 'research', 'highlights', 'knowledge-graph', 'digest']) {
    assert.match(html, new RegExp(`data-tab="${panel}"`), `missing ${panel} tab`);
    assert.match(html, new RegExp(`data-panel="${panel}"`), `missing ${panel} panel`);
  }

  for (const id of [
    'export-csv-btn',
    'export-json-btn',
    'import-file-input',
    'search-input',
    'sort-select',
    'grid-view-btn',
    'list-view-btn',
    'clear-search-btn',
    'kg-discover-btn',
    'conn-create-btn',
    'conn-refresh-btn',
    'digest-generate-btn',
    'digest-settings-btn',
    'digest-save-settings',
    'reminder-dismiss-all',
    'modal-cancel-btn',
    'modal-confirm-btn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id} workflow control`);
  }
});
