'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createNodeRemoteAdapters } = require('./node-remote-adapters');

function response() {
  const value = new EventEmitter();
  value.statusCode = 200;
  value.headers = { 'content-type': 'text/plain' };
  value[Symbol.asyncIterator] = async function* body() {
    yield Buffer.from('ok');
  };
  return value;
}

function requestFactory(calls) {
  return options => {
    const outgoing = new EventEmitter();
    outgoing.end = () => {
      calls.push(options);
      queueMicrotask(() => outgoing.emit('response', response()));
    };
    outgoing.destroy = () => {};
    return outgoing;
  };
}

test('node adapters preserve pinned request options and select the protocol implementation', async () => {
  const httpCalls = [];
  const httpsCalls = [];
  const lookups = [];
  const adapters = createNodeRemoteAdapters({
    lookup: async (hostname, options) => {
      lookups.push([hostname, options]);
      return [{ address: '203.0.113.1', family: 4 }];
    },
    httpRequest: requestFactory(httpCalls),
    httpsRequest: requestFactory(httpsCalls),
  });

  assert.deepEqual(await adapters.lookup('example.test', { all: true }), [{ address: '203.0.113.1', family: 4 }]);
  const result = await adapters.request({
    protocol: 'https:',
    hostname: '203.0.113.1',
    servername: 'example.test',
    port: 443,
    path: '/source',
    method: 'GET',
    headers: { host: 'example.test' },
    signal: new AbortController().signal,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(httpCalls.length, 0);
  assert.equal(httpsCalls.length, 1);
  assert.equal(httpsCalls[0].hostname, '203.0.113.1');
  assert.equal(httpsCalls[0].servername, 'example.test');
  assert.equal(Object.isFrozen(adapters), true);
  assert.equal(lookups.length, 1);
});

test('node request adapter rejects unsupported protocols and sanitized transport failures', async () => {
  const adapters = createNodeRemoteAdapters({
    lookup: async () => [],
    httpRequest() {
      const outgoing = new EventEmitter();
      outgoing.end = () => queueMicrotask(() => outgoing.emit('error', new Error('private transport detail')));
      outgoing.destroy = () => {};
      return outgoing;
    },
    httpsRequest: requestFactory([]),
  });

  await assert.rejects(
    adapters.request({ protocol: 'ftp:' }),
    error => error instanceof Error && !error.message.includes('private')
  );
  await assert.rejects(
    adapters.request({ protocol: 'http:', signal: new AbortController().signal }),
    error => error instanceof Error && !error.message.includes('private')
  );
});
