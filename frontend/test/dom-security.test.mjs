import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createSafeLink, createTextElement, normalizeExternalUrl, replaceChildren } from '../js/dom.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  get textContent() {
    return this._textContent;
  }

  set innerHTML(_value) {
    throw new Error('innerHTML is forbidden');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    this.children = [...children];
  }
}

const fakeDocument = {
  createElement(tagName) {
    return new FakeElement(tagName);
  },
};

test('text factories preserve hostile strings only as textContent', () => {
  const hostile = '<img src=x onerror="steal()"> & <script>bad()</script>';
  const element = createTextElement(fakeDocument, 'p', {
    text: hostile,
    className: 'safe-copy',
    attributes: { 'aria-label': hostile, 'data-kind': 'result' },
  });

  assert.equal(element.tagName, 'P');
  assert.equal(element.textContent, hostile);
  assert.equal(element.attributes.get('class'), 'safe-copy');
  assert.equal(element.attributes.get('aria-label'), hostile);
  assert.equal(element.children.length, 0);
});

test('DOM factories reject executable tags and event, style, URL, and source attributes', () => {
  for (const tagName of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta']) {
    assert.throws(() => createTextElement(fakeDocument, tagName, { text: 'no' }), /safe tag/);
  }
  for (const attribute of ['onclick', 'onerror', 'style', 'srcdoc', 'href', 'src']) {
    assert.throws(
      () =>
        createTextElement(fakeDocument, 'div', {
          text: 'safe',
          attributes: { [attribute]: 'javascript:bad()' },
        }),
      /safe attribute/
    );
  }
});

test('external URLs allow normalized HTTP(S) only and reject credentials or hostile protocols', () => {
  assert.equal(
    normalizeExternalUrl('HTTPS://Example.COM:443/a/../library?q=hello world'),
    'https://example.com/library?q=hello%20world'
  );
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>bad()</script>',
    'file:///secret',
    '//example.com/path',
    '/relative/path',
    'https://user:password@example.com/path',
    'https://example.com/path\u0000',
  ]) {
    assert.equal(normalizeExternalUrl(url), null);
  }
});

test('safe links never place a hostile URL in the DOM', () => {
  const hostile = createSafeLink(fakeDocument, {
    text: '<svg onload=bad()>',
    url: 'javascript:alert(1)',
    className: 'result-link',
  });
  assert.equal(hostile.tagName, 'SPAN');
  assert.equal(hostile.textContent, '<svg onload=bad()>');
  assert.equal(hostile.attributes.has('href'), false);
  assert.equal(hostile.attributes.get('aria-disabled'), 'true');

  const safe = createSafeLink(fakeDocument, {
    text: 'Open',
    url: 'https://example.com/path',
    className: 'result-link',
  });
  assert.equal(safe.tagName, 'A');
  assert.equal(safe.attributes.get('href'), 'https://example.com/path');
  assert.equal(safe.attributes.get('rel'), 'noopener noreferrer');
  assert.equal(safe.attributes.get('target'), '_blank');
});

test('replaceChildren uses the DOM replacement API without parsing strings', () => {
  const container = new FakeElement('div');
  const first = createTextElement(fakeDocument, 'span', { text: 'one' });
  const second = createTextElement(fakeDocument, 'span', { text: 'two' });

  replaceChildren(container, [first, second]);

  assert.deepEqual(container.children, [first, second]);
});

test('production DOM helper source contains no HTML parser sinks', async () => {
  const source = await readFile(new URL('../js/dom.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write/);
});
