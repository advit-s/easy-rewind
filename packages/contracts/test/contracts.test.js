import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { clone, ids, validFixtures } from './fixtures.js';

const packageRoot = resolve(import.meta.dirname, '..');

async function contracts() {
  return import('../src/index.js');
}

function ownKeyObject(key) {
  return JSON.parse(`{"${key}":{"polluted":true}}`);
}

test('public contract entry point exists and exposes every frozen module', async () => {
  const api = await contracts();

  for (const name of [
    'validateErrorResponse',
    'validateHealthResponse',
    'validatePaginationRequest',
    'validatePaginationResponse',
    'validateReminderCreateRequest',
    'validateReminderUpdateRequest',
    'validateReminderResponse',
    'validatePairingChallengeRequest',
    'validatePairingChallengeResponse',
    'validatePairingConfirmationRequest',
    'validatePairingCredentialIssueRequest',
    'validatePairingCredentialResponse',
    'validatePairingRevokeRequest',
    'validatePairingRevokeResponse',
    'validateSyncOperation',
    'validateSyncPushRequest',
    'validateSyncPushResponse',
    'validateSyncPullRequest',
    'validateSyncPullResponse',
    'validateSyncConflict',
    'validateSyncTombstone',
  ]) {
    assert.equal(typeof api[name], 'function', `${name} must be exported`);
  }
});

test('valid fixtures round-trip without mutation and reject top-level unknown fields', async () => {
  const api = await contracts();
  const cases = [
    ['validateErrorResponse', validFixtures.error],
    ['validateHealthResponse', validFixtures.health],
    ['validatePaginationRequest', validFixtures.paginationRequest],
    ['validatePaginationResponse', validFixtures.paginationResponse],
    ['validateReminderCreateRequest', validFixtures.reminderCreateRequest],
    ['validateReminderUpdateRequest', validFixtures.reminderUpdateRequest],
    ['validateReminderResponse', validFixtures.reminderResponse],
    ['validatePairingChallengeRequest', validFixtures.pairingChallengeRequest],
    ['validatePairingChallengeResponse', validFixtures.pairingChallengeResponse],
    ['validatePairingConfirmationRequest', validFixtures.pairingConfirmationRequest],
    ['validatePairingCredentialIssueRequest', validFixtures.pairingCredentialIssueRequest],
    ['validatePairingCredentialResponse', validFixtures.pairingCredentialResponse],
    ['validatePairingRevokeRequest', validFixtures.pairingRevokeRequest],
    ['validatePairingRevokeResponse', validFixtures.pairingRevokeResponse],
    ['validateSyncOperation', validFixtures.operation],
    ['validateSyncPushResponse', validFixtures.syncPushResponse],
  ];

  for (const [validatorName, fixture] of cases) {
    const before = JSON.stringify(fixture);
    assert.deepEqual(api[validatorName](fixture), { valid: true, errors: [] }, validatorName);
    assert.equal(JSON.stringify(fixture), before, `${validatorName} mutated its input`);
    assert.equal(
      api[validatorName]({ ...clone(fixture), unexpected: true }).valid,
      false,
      `${validatorName} accepted an unknown field`
    );
  }
});

test('validators reject missing fields, extra nested fields, null, and incorrect types', async () => {
  const api = await contracts();

  for (const value of [null, [], '', 0, false]) {
    assert.equal(api.validateHealthResponse(value).valid, false);
  }

  const missing = clone(validFixtures.health);
  delete missing.apiVersion;
  assert.equal(api.validateHealthResponse(missing).valid, false);

  const nestedUnknown = clone(validFixtures.health);
  nestedUnknown.components.database.storagePath = 'private';
  assert.equal(api.validateHealthResponse(nestedUnknown).valid, false);

  const nestedPairingUnknown = clone(validFixtures.pairingCredentialResponse);
  nestedPairingUnknown.device.hostname = 'private-host';
  assert.equal(api.validatePairingCredentialResponse(nestedPairingUnknown).valid, false);
});

test('validation failures are deterministic and never echo values or instance paths', async () => {
  const { validatePairingCredentialResponse } = await contracts();
  const invalid = clone(validFixtures.pairingCredentialResponse);
  invalid.credential.token = 'TOP_SECRET_VALUE';
  invalid.credential.extra = 'PRIVATE_PATH_VALUE';

  const first = validatePairingCredentialResponse(invalid);
  const second = validatePairingCredentialResponse(invalid);
  assert.deepEqual(first, second);
  assert.equal(first.valid, false);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /TOP_SECRET_VALUE|PRIVATE_PATH_VALUE|instancePath|schemaPath/i);
  assert.deepEqual(
    Object.keys(first.errors[0]).sort(),
    ['code', 'message'],
    'safe errors expose only stable code and message'
  );
});

test('common error envelope has exact stable codes and rejects unsafe or unstable content', async () => {
  const { ERROR_CODES, validateErrorResponse } = await contracts();
  assert.deepEqual(ERROR_CODES, [
    'auth_required',
    'auth_invalid',
    'forbidden',
    'not_found',
    'validation_failed',
    'conflict',
    'rate_limited',
    'internal_error',
    'api_version_unsupported',
    'cursor_expired',
    'device_revoked',
    'not_implemented',
  ]);

  for (const code of ERROR_CODES) {
    const fixture = clone(validFixtures.error);
    fixture.error.code = code;
    assert.equal(validateErrorResponse(fixture).valid, true, code);
  }

  for (const code of ['INTERNAL_ERROR', 'sql_error', 'stack_trace', '']) {
    const fixture = clone(validFixtures.error);
    fixture.error.code = code;
    assert.equal(validateErrorResponse(fixture).valid, false, code);
  }

  for (const message of [
    'See C:\\Users\\person\\database.sqlite',
    'Request to https://private-host failed',
    'Connect to localhost',
    'token=secret',
    'Error\nstack trace',
  ]) {
    const fixture = clone(validFixtures.error);
    fixture.error.message = message;
    assert.equal(validateErrorResponse(fixture).valid, false, message);
  }

  for (const unsafeKey of ['stack', 'path', 'cause']) {
    const fixture = clone(validFixtures.error);
    fixture.error[unsafeKey] = 'private';
    assert.equal(validateErrorResponse(fixture).valid, false);
  }
});

test('pagination is cursor-only and enforces positive bounded limits', async () => {
  const { MAX_PAGE_LIMIT, validatePaginationRequest, validatePaginationResponse } = await contracts();
  assert.equal(MAX_PAGE_LIMIT, 100);
  assert.equal(validatePaginationRequest({}).valid, true);
  assert.equal(validatePaginationRequest({ limit: 1 }).valid, true);
  assert.equal(validatePaginationRequest({ limit: MAX_PAGE_LIMIT }).valid, true);

  for (const limit of [-1, 0, 1.5, MAX_PAGE_LIMIT + 1, null, '10']) {
    assert.equal(validatePaginationRequest({ limit }).valid, false, String(limit));
  }
  for (const cursor of ['0', '12345', 'offset:10', '{"offset":10}', 'short', '', null]) {
    assert.equal(validatePaginationRequest({ cursor }).valid, false, String(cursor));
  }
  assert.equal(validatePaginationRequest({ offset: 10 }).valid, false);
  assert.equal(validatePaginationResponse({ items: [], nextCursor: null, hasMore: false }).valid, true);
  assert.equal(
    validatePaginationResponse({ items: [], nextCursor: null, hasMore: true }).valid,
    false,
    'hasMore requires a next cursor'
  );
  assert.equal(
    validatePaginationResponse({ items: [], nextCursor: ids.cursor, hasMore: false }).valid,
    false,
    'a next cursor requires hasMore'
  );
});

test('health exposes only stable readiness values and no operational secrets', async () => {
  const { HEALTH_MODES, HEALTH_STATUSES, COMPONENT_STATUSES, validateHealthResponse } = await contracts();
  assert.deepEqual(HEALTH_STATUSES, ['ok', 'degraded', 'unavailable']);
  assert.deepEqual(HEALTH_MODES, ['production', 'standalone', 'test']);
  assert.deepEqual(COMPONENT_STATUSES, ['ready', 'degraded', 'unavailable', 'disabled']);

  for (const leakedField of ['storagePath', 'hostname', 'apiKey', 'rowCount', 'rows']) {
    const fixture = clone(validFixtures.health);
    fixture[leakedField] = 'private';
    assert.equal(validateHealthResponse(fixture).valid, false);
  }
  for (const leakedComponentField of ['path', 'host', 'key', 'count', 'contents']) {
    const fixture = clone(validFixtures.health);
    fixture.components.database[leakedComponentField] = 'private';
    assert.equal(validateHealthResponse(fixture).valid, false);
  }
});

test('reminder state vocabulary and transition table are complete and terminal states remain terminal', async () => {
  const { REMINDER_STATES, REMINDER_TRANSITIONS, canTransitionReminder, validateReminderTransition } =
    await contracts();
  assert.deepEqual(REMINDER_STATES, ['scheduled', 'snoozed', 'due', 'completed', 'cancelled', 'failed']);
  assert.deepEqual(Object.keys(REMINDER_TRANSITIONS), REMINDER_STATES);
  assert.deepEqual(REMINDER_TRANSITIONS.completed, []);
  assert.deepEqual(REMINDER_TRANSITIONS.cancelled, []);
  assert.deepEqual(REMINDER_TRANSITIONS.failed, []);

  for (const from of REMINDER_STATES) {
    for (const to of REMINDER_STATES) {
      const expected = REMINDER_TRANSITIONS[from].includes(to);
      assert.equal(canTransitionReminder(from, to), expected, `${from} -> ${to}`);
      assert.equal(validateReminderTransition({ from, to }).valid, expected, `${from} -> ${to}`);
    }
  }
  assert.equal(validateReminderTransition({ from: 'unknown', to: 'due' }).valid, false);
  assert.equal(validateReminderTransition({ from: 'due', to: 'due' }).valid, false);
  assert.equal(
    validateReminderTransition({
      from: 'scheduled',
      to: 'due',
      __proto__: { polluted: true },
    }).valid,
    false
  );
});

test('reminder contracts enforce request bounds and exact response states', async () => {
  const { validateReminderCreateRequest, validateReminderResponse } = await contracts();
  const oversized = clone(validFixtures.reminderCreateRequest);
  oversized.title = 'x'.repeat(201);
  assert.equal(validateReminderCreateRequest(oversized).valid, false);

  const invalidTime = clone(validFixtures.reminderCreateRequest);
  invalidTime.scheduledFor = -1;
  assert.equal(validateReminderCreateRequest(invalidTime).valid, false);

  for (const state of ['pending', 'deleted', 'SCHEDULED', null]) {
    const fixture = clone(validFixtures.reminderResponse);
    fixture.reminder.state = state;
    assert.equal(validateReminderResponse(fixture).valid, false, String(state));
  }
});

test('pairing schemas require one-use expiry, explicit confirmation, and isolate credentials', async () => {
  const {
    validatePairingChallengeRequest,
    validatePairingChallengeResponse,
    validatePairingConfirmationRequest,
    validatePairingCredentialResponse,
    validatePairingRevokeRequest,
  } = await contracts();

  assert.equal(validatePairingConfirmationRequest({ challengeId: ids.challenge, confirmed: false }).valid, false);
  assert.equal(validatePairingChallengeResponse({ challengeId: ids.challenge }).valid, false);
  assert.equal(
    validatePairingChallengeResponse({
      ...validFixtures.pairingChallengeResponse,
      oneUse: false,
    }).valid,
    false
  );
  assert.equal(validatePairingChallengeRequest({ deviceName: 'x'.repeat(65), platform: 'android' }).valid, false);
  assert.equal(
    validatePairingCredentialResponse({
      ...clone(validFixtures.pairingCredentialResponse),
      credential: { tokenType: 'Bearer', issuedAt: 1_700_000_000_000 },
    }).valid,
    false
  );
  assert.equal(validatePairingRevokeRequest({ deviceId: ids.device, reason: 'arbitrary_reason' }).valid, false);
});

test('sync operation envelopes enforce vocabularies, bounds, and delete semantics', async () => {
  const { SYNC_ENTITY_TYPES, SYNC_OPERATION_KINDS, validateSyncOperation } = await contracts();
  assert.deepEqual(SYNC_OPERATION_KINDS, ['upsert', 'delete']);
  assert.ok(SYNC_ENTITY_TYPES.includes('reminder'));

  for (const field of ['operationId', 'deviceId', 'entityType', 'entityId', 'kind', 'payload']) {
    const fixture = clone(validFixtures.operation);
    delete fixture[field];
    assert.equal(validateSyncOperation(fixture).valid, false, field);
  }

  for (const [field, value] of [
    ['operationId', 'not-a-uuid'],
    ['entityType', 'database_row'],
    ['kind', 'patch'],
    ['baseRevision', -1],
    ['occurredAt', 1.5],
  ]) {
    const fixture = clone(validFixtures.operation);
    fixture[field] = value;
    assert.equal(validateSyncOperation(fixture).valid, false, field);
  }

  const deletion = clone(validFixtures.operation);
  deletion.kind = 'delete';
  deletion.payload = {};
  assert.equal(validateSyncOperation(deletion).valid, true);
  deletion.payload = { title: 'must not accompany tombstone' };
  assert.equal(validateSyncOperation(deletion).valid, false);
});

test('sync payloads reject prototype-pollution keys, excessive depth, and excessive size', async () => {
  const { MAX_SYNC_PAYLOAD_DEPTH, MAX_SYNC_PAYLOAD_CHARACTERS, validateSyncOperation } = await contracts();

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const fixture = clone(validFixtures.operation);
    fixture.payload = ownKeyObject(key);
    assert.equal(validateSyncOperation(fixture).valid, false, key);
  }

  const deep = {};
  let current = deep;
  for (let index = 0; index <= MAX_SYNC_PAYLOAD_DEPTH; index += 1) {
    current.next = {};
    current = current.next;
  }
  const deepFixture = clone(validFixtures.operation);
  deepFixture.payload = deep;
  assert.equal(validateSyncOperation(deepFixture).valid, false);

  const largeFixture = clone(validFixtures.operation);
  largeFixture.payload = { value: 'x'.repeat(MAX_SYNC_PAYLOAD_CHARACTERS) };
  assert.equal(validateSyncOperation(largeFixture).valid, false);
});

test('sync batches are bounded and reject duplicate operation identifiers', async () => {
  const { MAX_SYNC_BATCH_SIZE, validateSyncPushRequest, validateSyncPushResponse } = await contracts();
  const operation = clone(validFixtures.operation);
  assert.equal(validateSyncPushRequest({ deviceId: ids.device, operations: [operation] }).valid, true);
  assert.equal(validateSyncPushRequest({ deviceId: ids.device, operations: [] }).valid, false);
  assert.equal(
    validateSyncPushRequest({
      deviceId: ids.device,
      operations: Array.from({ length: MAX_SYNC_BATCH_SIZE + 1 }, (_, index) => ({
        ...clone(operation),
        operationId: `${index.toString(16).padStart(8, '0')}-9dad-4d1f-80b4-00c04fd430c8`,
      })),
    }).valid,
    false
  );
  assert.equal(
    validateSyncPushRequest({ deviceId: ids.device, operations: [operation, clone(operation)] }).valid,
    false
  );

  const response = {
    results: [{ operationId: ids.operation, status: 'accepted', revision: 1 }],
    serverTime: 1_700_000_000_000,
  };
  assert.equal(validateSyncPushResponse(response).valid, true);
  assert.equal(
    validateSyncPushResponse({ ...response, results: [...response.results, ...response.results] }).valid,
    false
  );
});

test('sync pull, conflict, tombstone, and cursor-expiry forms are frozen', async () => {
  const {
    validateErrorResponse,
    validateSyncPullRequest,
    validateSyncPullResponse,
    validateSyncConflict,
    validateSyncTombstone,
  } = await contracts();

  assert.equal(validateSyncPullRequest({ deviceId: ids.device, cursor: ids.cursor, limit: 100 }).valid, true);
  assert.equal(validateSyncPullRequest({ deviceId: ids.device, cursor: '123' }).valid, false);

  const tombstone = {
    entityType: 'reminder',
    entityId: ids.entity,
    revision: 3,
    deletedAt: 1_700_000_000_000,
  };
  assert.equal(validateSyncTombstone(tombstone).valid, true);
  assert.equal(validateSyncTombstone({ ...tombstone, payload: {} }).valid, false);

  const conflict = {
    conflictId: ids.conflict,
    entityType: 'reminder',
    entityId: ids.entity,
    localRevision: 2,
    remoteRevision: 3,
    status: 'unresolved',
    detectedAt: 1_700_000_000_000,
    resolvedAt: null,
  };
  assert.equal(validateSyncConflict(conflict).valid, true);

  const pull = {
    changes: [
      {
        changeId: ids.operation2,
        entityType: 'reminder',
        entityId: ids.entity,
        kind: 'delete',
        revision: 3,
        payload: {},
        changedAt: 1_700_000_000_000,
      },
    ],
    nextCursor: null,
    hasMore: false,
    serverTime: 1_700_000_000_000,
  };
  assert.equal(validateSyncPullResponse(pull).valid, true);

  const cursorExpired = clone(validFixtures.error);
  cursorExpired.error.code = 'cursor_expired';
  assert.equal(validateErrorResponse(cursorExpired).valid, true);
  delete cursorExpired.error.requestId;
  assert.equal(validateErrorResponse(cursorExpired).valid, false);
});

test('all canonical schemas use unique identifiers and close every contract object', async () => {
  const { listCanonicalSchemas } = await import('../scripts/generate-openapi.mjs');
  const schemas = listCanonicalSchemas(packageRoot);
  const idsSeen = schemas.map(({ schema }) => schema.$id);
  assert.equal(new Set(idsSeen).size, idsSeen.length);

  function inspect(node, location) {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'object' &&
      !location.endsWith(':$.$defs.JsonObject') &&
      !location.endsWith(':$.$defs.PaginationItem')
    ) {
      assert.equal(node.additionalProperties, false, `${location} is not closed`);
    }
    for (const [key, value] of Object.entries(node)) {
      inspect(value, `${location}.${key}`);
    }
  }

  for (const { filename, schema } of schemas) inspect(schema, `${filename}:$`);
});

test('OpenAPI 3.1 resolves every reference, covers frozen endpoints, and matches generated bytes', async () => {
  const { generateOpenApiText, listCanonicalSchemas } = await import('../scripts/generate-openapi.mjs');
  const repositoryRoot = resolve(packageRoot, '..', '..');
  const openApiPath = join(repositoryRoot, 'docs', 'api', 'openapi.json');
  const actual = readFileSync(openApiPath, 'utf8');
  assert.equal(actual, generateOpenApiText(packageRoot), 'OpenAPI drift detected');

  const document = JSON.parse(actual);
  assert.equal(document.openapi, '3.1.0');
  assert.equal(Object.hasOwn(document, 'servers'), false);
  for (const path of [
    '/v1/health',
    '/v1/session',
    '/v1/pairing/challenges',
    '/v1/pairing/confirmations',
    '/v1/pairing/credentials',
    '/v1/pairing/revocations',
    '/v1/sync/push',
    '/v1/sync/pull',
  ]) {
    assert.equal(typeof document.paths[path], 'object', `missing ${path}`);
  }

  const serialized = JSON.stringify(document);
  assert.doesNotMatch(serialized, /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])|storagePath|hostname/i);
  const refs = [...serialized.matchAll(/"\$ref":"([^"]+)"/g)].map(match => match[1]);
  const canonicalIds = new Set(listCanonicalSchemas(packageRoot).map(({ schema }) => schema.$id));
  for (const ref of refs) {
    if (ref.startsWith('#/components/schemas/')) {
      const name = ref.slice('#/components/schemas/'.length);
      assert.ok(document.components.schemas[name], `unresolved ${ref}`);
    } else {
      assert.ok(
        [...canonicalIds].some(id => ref.startsWith(`${id}#`)),
        `non-canonical or unresolved ${ref}`
      );
    }
  }
});

test('credential token is writeOnly only in the credential issue response schema', async () => {
  const { listCanonicalSchemas } = await import('../scripts/generate-openapi.mjs');
  const schemas = listCanonicalSchemas(packageRoot);
  const occurrences = [];

  function inspect(node, location) {
    if (!node || typeof node !== 'object') return;
    if (node.writeOnly === true) occurrences.push(location);
    for (const [key, value] of Object.entries(node)) inspect(value, `${location}.${key}`);
  }
  for (const { filename, schema } of schemas) inspect(schema, filename);

  assert.deepEqual(occurrences, ['pairing.json.$defs.PairingCredential.properties.token']);
});
