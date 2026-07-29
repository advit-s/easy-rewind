import assert from 'node:assert/strict';
import test from 'node:test';

import { createSafeLink, createTextElement, normalizeSafeWebUrl, replaceChildren } from '../src/safe-dom.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    this.children = children;
    this.textContent = '';
  }
}

const document = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

test('normalizes only credential-free HTTP and HTTPS URLs', () => {
  assert.equal(normalizeSafeWebUrl('https://example.test/article?q=1'), 'https://example.test/article?q=1');
  assert.equal(normalizeSafeWebUrl('http://example.test/'), 'http://example.test/');
  const credentialedUrl = new URL('https://example.test/');
  credentialedUrl.username = ['browser', 'user'].join('-');
  credentialedUrl.password = ['browser', 'password'].join('-');

  for (const value of [
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'file:///private',
    credentialedUrl.href,
    '//example.test/path',
    '',
    null,
  ]) {
    assert.equal(normalizeSafeWebUrl(value), null, String(value));
  }
});

test('creates text elements without interpreting hostile markup', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const element = createTextElement(document, 'p', {
    text: hostile,
    className: 'copy',
    attributes: { id: 'summary', 'aria-live': 'polite' },
  });

  assert.equal(element.tagName, 'P');
  assert.equal(element.textContent, hostile);
  assert.equal(element.className, 'copy');
  assert.equal(element.attributes.get('id'), 'summary');
  assert.equal(element.attributes.get('aria-live'), 'polite');
  assert.deepEqual(element.children, []);
});

test('creates safe links and rejects unsafe destinations', () => {
  const link = createSafeLink(document, {
    url: 'https://example.test/read',
    text: 'Open page',
    className: 'link',
  });

  assert.equal(link.tagName, 'A');
  assert.equal(link.textContent, 'Open page');
  assert.equal(link.attributes.get('href'), 'https://example.test/read');
  assert.equal(link.attributes.get('rel'), 'noreferrer noopener');

  assert.equal(createSafeLink(document, { url: 'javascript:alert(1)', text: 'Unsafe' }), null);
  assert.equal(createSafeLink(document, { url: 'data:text/plain,test', text: 'Unsafe' }), null);
});

test('replaces container children through the DOM API', () => {
  const container = new FakeElement('div');
  const first = new FakeElement('span');
  const second = new FakeElement('button');

  replaceChildren(container, first, null, second);

  assert.deepEqual(container.children, [first, second]);
});
