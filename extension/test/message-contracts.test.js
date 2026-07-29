import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTENSION_MESSAGE_TYPES, MESSAGE_LIMITS, validateExtensionMessage } from '../src/message-contracts.js';

const validMessages = [
  { type: 'GET_EXTENSION_STATE' },
  { type: 'GET_PRIVACY_SNAPSHOT' },
  { type: 'GET_PAGE_SNAPSHOT' },
  { type: 'CHECK_CONNECTION' },
  { type: 'RETRY_SYNC' },
  {
    type: 'SET_LOCAL_AUTHORIZATION',
    payload: { connectionCode: `Bearer eri_install-1.${'A'.repeat(43)}` },
  },
  { type: 'CLEAR_LOCAL_AUTHORIZATION' },
  { type: 'SET_CAPTURE_ENABLED', payload: { enabled: true } },
  {
    type: 'UPDATE_PRIVACY',
    payload: {
      allowedHosts: ['docs.example.test'],
      blockedHosts: ['account.example.test'],
      minimumDwellMs: 15_000,
      minimumSelectionLength: 24,
    },
  },
  {
    type: 'CAPTURE_PAGE',
    payload: {
      url: 'https://example.test/article',
      title: 'Article',
      text: 'Bounded page text',
      occurredAt: 1_234,
    },
  },
  {
    type: 'CAPTURE_SELECTION',
    payload: {
      url: 'https://example.test/article',
      title: 'Article',
      text: 'Selected text',
      occurredAt: 1_235,
    },
  },
  {
    type: 'PRIVACY_CHANGED',
    payload: {
      captureEnabled: false,
      allowedHosts: [],
      blockedHosts: [],
      minimumDwellMs: 15_000,
      minimumSelectionLength: 24,
    },
  },
];

test('message type allowlist is frozen and every popup/content/background flow validates', () => {
  assert.equal(Object.isFrozen(EXTENSION_MESSAGE_TYPES), true);
  assert.deepEqual(
    [...EXTENSION_MESSAGE_TYPES],
    validMessages.map(message => message.type)
  );

  for (const input of validMessages) {
    const result = validateExtensionMessage(input);
    assert.equal(result.valid, true, input.type);
    assert.deepEqual(result.message, input);
    assert.equal(Object.isFrozen(result.message), true);
    if (result.message.payload) assert.equal(Object.isFrozen(result.message.payload), true);
  }
});

test('messages require an own allowlisted type and the exact root shape', () => {
  const inheritedType = Object.create({ type: 'GET_EXTENSION_STATE' });
  const cases = [
    null,
    [],
    inheritedType,
    { type: 'UNKNOWN' },
    { type: 'GET_EXTENSION_STATE', payload: {} },
    { type: 'GET_EXTENSION_STATE', extra: true },
    { type: 'SET_CAPTURE_ENABLED' },
    { type: 'SET_CAPTURE_ENABLED', payload: { enabled: true }, extra: true },
  ];

  for (const input of cases) {
    assert.deepEqual(validateExtensionMessage(input), {
      valid: false,
      error: 'invalid_message',
    });
  }
});

test('payload schemas reject missing, extra, and wrongly typed fields', () => {
  const cases = [
    { type: 'SET_CAPTURE_ENABLED', payload: { enabled: 1 } },
    { type: 'SET_CAPTURE_ENABLED', payload: { enabled: true, reason: 'extra' } },
    {
      type: 'UPDATE_PRIVACY',
      payload: {
        allowedHosts: [],
        blockedHosts: [],
        minimumDwellMs: -1,
        minimumSelectionLength: 24,
      },
    },
    {
      type: 'CAPTURE_PAGE',
      payload: {
        url: 'file:///private',
        title: 'Invalid scheme',
        text: 'text',
        occurredAt: 1,
      },
    },
    {
      type: 'CAPTURE_SELECTION',
      payload: {
        url: 'https://example.test',
        title: 'Missing text',
        occurredAt: 1,
      },
    },
  ];

  for (const input of cases) assert.equal(validateExtensionMessage(input).valid, false);
});

test('messages reject inherited, dangerous, owner, and credential fields recursively', () => {
  const inheritedPayload = Object.create({ enabled: true });
  const pollutedPayload = JSON.parse('{"enabled":true,"__proto__":{"polluted":true}}');
  const cases = [
    { type: 'SET_CAPTURE_ENABLED', payload: inheritedPayload },
    { type: 'SET_CAPTURE_ENABLED', payload: pollutedPayload },
    {
      type: 'CAPTURE_PAGE',
      payload: {
        url: 'https://example.test',
        title: 'Title',
        text: 'Text',
        occurredAt: 1,
        nested: { ownerId: 'owner-1' },
      },
    },
    {
      type: 'UPDATE_PRIVACY',
      payload: {
        allowedHosts: [],
        blockedHosts: [],
        minimumDwellMs: 1,
        minimumSelectionLength: 1,
        password: 'never-send',
      },
    },
    {
      type: 'CAPTURE_SELECTION',
      payload: {
        url: 'https://example.test',
        title: 'Title',
        text: 'Text',
        occurredAt: 1,
        profileId: 'profile-1',
      },
    },
    {
      type: 'SET_LOCAL_AUTHORIZATION',
      payload: {
        connectionCode: `Bearer eri_install-1.${'A'.repeat(43)}`,
        provider: 'gemini',
      },
    },
  ];

  for (const input of cases) assert.equal(validateExtensionMessage(input).valid, false);
});

test('desktop connection-code messages have exact bounded payloads without credential-shaped keys', () => {
  const valid = `Bearer eri_install-1.${'A'.repeat(43)}`;
  const cases = [
    { type: 'SET_LOCAL_AUTHORIZATION' },
    { type: 'SET_LOCAL_AUTHORIZATION', payload: { connectionCode: '' } },
    {
      type: 'SET_LOCAL_AUTHORIZATION',
      payload: { connectionCode: `${valid}${'x'.repeat(MESSAGE_LIMITS.maxConnectionCodeLength)}` },
    },
    {
      type: 'SET_LOCAL_AUTHORIZATION',
      payload: { connectionCode: valid, token: valid },
    },
    { type: 'CLEAR_LOCAL_AUTHORIZATION', payload: {} },
  ];

  for (const input of cases) assert.equal(validateExtensionMessage(input).valid, false);
});

test('payload bounds reject oversized text, URLs, host lists, depth, and cycles', () => {
  const tooManyHosts = Array.from({ length: MESSAGE_LIMITS.maxHosts + 1 }, (_, index) => `host-${index}.example.test`);
  const cyclic = { enabled: true };
  cyclic.self = cyclic;
  let deep = { enabled: true };
  for (let index = 0; index < 12; index += 1) deep = { child: deep };

  const cases = [
    {
      type: 'CAPTURE_PAGE',
      payload: {
        url: `https://example.test/${'x'.repeat(MESSAGE_LIMITS.maxUrlLength)}`,
        title: 'Title',
        text: 'Text',
        occurredAt: 1,
      },
    },
    {
      type: 'CAPTURE_PAGE',
      payload: {
        url: 'https://example.test',
        title: 'Title',
        text: 'x'.repeat(MESSAGE_LIMITS.maxPageTextLength + 1),
        occurredAt: 1,
      },
    },
    {
      type: 'UPDATE_PRIVACY',
      payload: {
        allowedHosts: tooManyHosts,
        blockedHosts: [],
        minimumDwellMs: 1,
        minimumSelectionLength: 1,
      },
    },
    { type: 'SET_CAPTURE_ENABLED', payload: cyclic },
    { type: 'SET_CAPTURE_ENABLED', payload: deep },
  ];

  for (const input of cases) assert.equal(validateExtensionMessage(input).valid, false);
});

test('validated messages are detached from mutable input', () => {
  const input = {
    type: 'UPDATE_PRIVACY',
    payload: {
      allowedHosts: ['example.test'],
      blockedHosts: [],
      minimumDwellMs: 1,
      minimumSelectionLength: 1,
    },
  };
  const result = validateExtensionMessage(input);

  input.payload.allowedHosts[0] = 'changed.test';

  assert.equal(result.valid, true);
  assert.deepEqual(result.message.payload.allowedHosts, ['example.test']);
  assert.equal(Object.isFrozen(result.message.payload.allowedHosts), true);
});
