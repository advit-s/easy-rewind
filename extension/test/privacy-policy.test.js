import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PRIVACY_SNAPSHOT,
  evaluateCapture,
  hostMatchesRule,
  isSelectionCaptureAllowed,
} from '../src/privacy-policy.js';

function page(overrides = {}) {
  return {
    querySelector() {
      return null;
    },
    ...overrides,
  };
}

test('capture is disabled by default and the default snapshot is immutable', () => {
  assert.equal(DEFAULT_PRIVACY_SNAPSHOT.captureEnabled, false);
  assert.equal(Object.isFrozen(DEFAULT_PRIVACY_SNAPSHOT), true);
  assert.equal(
    evaluateCapture({
      settings: DEFAULT_PRIVACY_SNAPSHOT,
      location: new URL('https://docs.example.test/guide'),
      document: page(),
    }).allowed,
    false
  );
});

test('host rules are exact and wildcard rules match subdomains only', () => {
  assert.equal(hostMatchesRule('docs.example.test', 'docs.example.test'), true);
  assert.equal(hostMatchesRule('other.example.test', 'docs.example.test'), false);
  assert.equal(hostMatchesRule('a.example.test', '*.example.test'), true);
  assert.equal(hostMatchesRule('deep.a.example.test', '*.example.test'), true);
  assert.equal(hostMatchesRule('example.test', '*.example.test'), false);
  assert.equal(hostMatchesRule('notexample.test', '*.example.test'), false);
});

test('only http pages may be captured and block rules win over allow rules', () => {
  const settings = {
    captureEnabled: true,
    allowedHosts: ['*.example.test'],
    blockedHosts: ['private.example.test'],
    minimumDwellMs: 1_000,
    minimumSelectionLength: 8,
  };

  for (const url of ['chrome://settings', 'file:///private.txt', 'about:blank']) {
    assert.equal(evaluateCapture({ settings, location: new URL(url), document: page() }).allowed, false);
  }
  assert.equal(
    evaluateCapture({
      settings,
      location: new URL('https://private.example.test/article'),
      document: page(),
    }).allowed,
    false
  );
  assert.equal(
    evaluateCapture({
      settings,
      location: new URL('https://unlisted.test/article'),
      document: page(),
    }).allowed,
    false
  );
});

test('password, payment, health, and account-sensitive pages are rejected', () => {
  const settings = {
    captureEnabled: true,
    allowedHosts: [],
    blockedHosts: [],
    minimumDwellMs: 1_000,
    minimumSelectionLength: 8,
  };
  const sensitiveUrls = [
    'https://example.test/login',
    'https://example.test/account/profile',
    'https://example.test/checkout/payment',
    'https://example.test/patient/health-record',
    'https://accounts.example.test/home',
    'https://payments.example.test/home',
    'https://mychart.example.test/home',
  ];

  for (const url of sensitiveUrls) {
    assert.equal(evaluateCapture({ settings, location: new URL(url), document: page() }).allowed, false, url);
  }

  assert.equal(
    evaluateCapture({
      settings,
      location: new URL('https://example.test/article'),
      document: page({
        querySelector(selector) {
          return selector.includes('input[type="password"]') ? {} : null;
        },
      }),
    }).allowed,
    false
  );
});

test('minimum dwell and selection thresholds are enforced', () => {
  const settings = {
    captureEnabled: true,
    allowedHosts: [],
    blockedHosts: [],
    minimumDwellMs: 5_000,
    minimumSelectionLength: 12,
  };
  const decision = evaluateCapture({
    settings,
    location: new URL('https://example.test/article'),
    document: page(),
    dwellMs: 4_999,
    selectionLength: 11,
  });

  assert.equal(decision.pageCaptureAllowed, false);
  assert.equal(decision.selectionCaptureAllowed, false);
  assert.equal(
    evaluateCapture({
      settings,
      location: new URL('https://example.test/article'),
      document: page(),
      dwellMs: 5_000,
      selectionLength: 12,
    }).pageCaptureAllowed,
    true
  );
});

test('selections from editable and form controls are never capturable', () => {
  const formControl = { closest: () => ({}) };
  const articleText = { closest: () => null };

  assert.equal(isSelectionCaptureAllowed({ anchorNode: formControl }, 20, 8), false);
  assert.equal(isSelectionCaptureAllowed({ anchorNode: articleText }, 7, 8), false);
  assert.equal(isSelectionCaptureAllowed({ anchorNode: articleText }, 8, 8), true);
});
