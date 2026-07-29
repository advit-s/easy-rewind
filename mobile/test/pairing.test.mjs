import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PairingError,
  createPairingService,
  pairingCredentialKey,
  pairingIdentityKey,
} from '../src/pairing/pairing-service.ts';
import { PAIRING_PROTOCOL_VERSION, parsePairingQrPayload } from '../src/pairing/qr-payload.ts';
import { TlsPinMismatchError, assertTlsFingerprint, createPinnedPairingRequest } from '../src/pairing/tls-pin.ts';

const NOW = 1_800_000_000_000;
const CHALLENGE_ID = 'challenge_FYB3D6mR6Yhs4jK9sGvQ2fE1';
const INSTALLATION_ID = 'installation_FYB3D6mR6Yhs4jK9';
const DEVICE_ID = '6ba7b810-9dad-4d1f-80b4-00c04fd430c8';
const FINGERPRINT = `sha256:${'ab'.repeat(32)}`;
const OTHER_FINGERPRINT = `sha256:${'cd'.repeat(32)}`;
const TOKEN = 'device_6Yhs4jK9sGvQ2fE1FYB3D6mR6Yhs4jK9';

function qr(overrides = {}) {
  return {
    protocolVersion: '1',
    syncEndpoint: 'https://192.168.1.20:9443/v1/sync',
    tlsFingerprint: FINGERPRINT,
    installationId: INSTALLATION_ID,
    challengeId: CHALLENGE_ID,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function credentialResponse(overrides = {}) {
  return {
    device: {
      deviceId: DEVICE_ID,
      name: 'Pixel 10',
      platform: 'android',
      status: 'active',
      createdAt: NOW,
      lastSeenAt: null,
    },
    credential: {
      token: TOKEN,
      tokenType: 'Bearer',
      issuedAt: NOW,
    },
    ...overrides,
  };
}

function memoryCredentialStore() {
  const values = new Map();
  const operations = [];
  return {
    values,
    operations,
    async get(key) {
      operations.push(['get', key]);
      return values.get(key) ?? null;
    },
    async set(key, value) {
      operations.push(['set', key, value]);
      values.set(key, value);
    },
    async remove(key) {
      operations.push(['remove', key]);
      values.delete(key);
    },
  };
}

function response(status, value) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

function makeService({ replies = [response(200, credentialResponse())], transportError } = {}) {
  const credentialStore = memoryCredentialStore();
  const requests = [];
  const queue = [...replies];
  const transport = {
    async request(request) {
      requests.push(request);
      if (transportError) throw transportError;
      const next = queue.shift();
      if (!next) throw new Error('Unexpected transport request');
      return next;
    },
  };
  const service = createPairingService({
    clock: { now: () => NOW },
    credentialStore,
    transport,
  });
  return { credentialStore, requests, service };
}

function expectPairingError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof PairingError);
    assert.equal(error.code, code);
    return true;
  });
}

async function expectPairingRejection(action, code) {
  await assert.rejects(action, error => {
    assert.ok(error instanceof PairingError);
    assert.equal(error.code, code);
    return true;
  });
}

test('QR parser freezes the exact protocol-v1 private-LAN payload', () => {
  const parsed = parsePairingQrPayload(JSON.stringify(qr()), { now: NOW });

  assert.equal(PAIRING_PROTOCOL_VERSION, '1');
  assert.deepEqual(parsed, qr());
  assert.equal(Object.isFrozen(parsed), true);

  for (const key of Object.keys(qr())) {
    const missing = qr();
    delete missing[key];
    expectPairingError(() => parsePairingQrPayload(missing, { now: NOW }), 'PAIRING_QR_INVALID');
  }

  expectPairingError(() => parsePairingQrPayload({ ...qr(), unexpected: true }, { now: NOW }), 'PAIRING_QR_INVALID');
  expectPairingError(
    () => parsePairingQrPayload(qr({ protocolVersion: '2' }), { now: NOW }),
    'PAIRING_PROTOCOL_UNSUPPORTED'
  );
  expectPairingError(
    () => parsePairingQrPayload(qr({ syncEndpoint: 'https://8.8.8.8:9443/v1/sync' }), { now: NOW }),
    'PAIRING_QR_INVALID'
  );
});

test('QR parser rejects expired challenges and malformed fingerprints', () => {
  expectPairingError(() => parsePairingQrPayload(qr({ expiresAt: NOW }), { now: NOW }), 'PAIRING_CHALLENGE_EXPIRED');
  expectPairingError(
    () => parsePairingQrPayload(qr({ tlsFingerprint: `sha256:${'AB'.repeat(32)}` }), { now: NOW }),
    'PAIRING_QR_INVALID'
  );
});

test('TLS pinning is exact and every pairing request carries the expected SHA-256 pin', () => {
  assert.equal(assertTlsFingerprint(FINGERPRINT, FINGERPRINT), FINGERPRINT);
  assert.throws(() => assertTlsFingerprint(FINGERPRINT, OTHER_FINGERPRINT), TlsPinMismatchError);

  const request = createPinnedPairingRequest({
    syncEndpoint: qr().syncEndpoint,
    tlsFingerprint: FINGERPRINT,
    body: { action: 'issue', challengeId: CHALLENGE_ID, installationId: INSTALLATION_ID },
  });
  assert.deepEqual(request, {
    url: 'https://192.168.1.20:9443/v1/pairing/bootstrap',
    method: 'POST',
    expectedTlsFingerprintSha256: FINGERPRINT,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'issue',
      challengeId: CHALLENGE_ID,
      installationId: INSTALLATION_ID,
    }),
    timeoutMs: 10_000,
  });
  assert.equal(Object.isFrozen(request), true);
});

test('pairing requires the complete confirmed state sequence and preserves the device name', async () => {
  const { credentialStore, requests, service } = makeService();

  assert.deepEqual(service.getState(), { status: 'idle' });
  assert.deepEqual(service.scan(JSON.stringify(qr()), { deviceName: '  Pixel 10  ' }), {
    status: 'scanned',
    deviceName: 'Pixel 10',
    installationId: INSTALLATION_ID,
    expiresAt: NOW + 60_000,
  });
  assert.deepEqual(service.awaitPcConfirmation(), {
    status: 'awaiting_confirmation',
    deviceName: 'Pixel 10',
    installationId: INSTALLATION_ID,
    expiresAt: NOW + 60_000,
  });

  await expectPairingRejection(() => service.pair({ pcConfirmed: false }), 'PAIRING_PC_CONFIRMATION_REQUIRED');
  assert.equal(requests.length, 0);
  assert.equal(service.getState().status, 'awaiting_confirmation');

  const paired = await service.pair({ pcConfirmed: true });
  assert.deepEqual(paired, {
    status: 'paired',
    deviceId: DEVICE_ID,
    deviceName: 'Pixel 10',
    installationId: INSTALLATION_ID,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expectedTlsFingerprintSha256, FINGERPRINT);
  assert.equal(requests[0].url, 'https://192.168.1.20:9443/v1/pairing/bootstrap');

  assert.equal(credentialStore.values.get(pairingCredentialKey(INSTALLATION_ID)), TOKEN);
  assert.deepEqual(JSON.parse(credentialStore.values.get(pairingIdentityKey(INSTALLATION_ID))), {
    protocolVersion: '1',
    syncEndpoint: qr().syncEndpoint,
    tlsFingerprint: FINGERPRINT,
    installationId: INSTALLATION_ID,
    deviceId: DEVICE_ID,
    deviceName: 'Pixel 10',
  });
  assert.equal(JSON.stringify(service.getState()).includes(TOKEN), false);
});

test('a challenge is one-use and cannot be replayed after credential issuance', async () => {
  const { service } = makeService();
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();
  await service.pair({ pcConfirmed: true });

  service.reset();
  expectPairingError(() => service.scan(qr(), { deviceName: 'Pixel 10' }), 'PAIRING_CHALLENGE_CONSUMED');
});

test('server expiry and rejection become terminal without storing credentials', async () => {
  for (const fixture of [
    {
      status: 410,
      body: { error: { code: 'pairing_challenge_expired', message: 'Expired.' } },
      expected: 'expired',
      code: 'PAIRING_CHALLENGE_EXPIRED',
    },
    {
      status: 403,
      body: { error: { code: 'pairing_rejected', message: 'Rejected.' } },
      expected: 'rejected',
      code: 'PAIRING_REJECTED',
    },
  ]) {
    const { credentialStore, service } = makeService({
      replies: [response(fixture.status, fixture.body)],
    });
    service.scan(qr(), { deviceName: 'Pixel 10' });
    service.awaitPcConfirmation();
    await expectPairingRejection(() => service.pair({ pcConfirmed: true }), fixture.code);
    assert.equal(service.getState().status, fixture.expected);
    assert.equal(credentialStore.values.size, 0);
  }
});

test('TLS mismatch always fails closed with no unpinned fallback or credential write', async () => {
  const mismatch = new TlsPinMismatchError(FINGERPRINT, OTHER_FINGERPRINT);
  const { credentialStore, requests, service } = makeService({ transportError: mismatch });
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();

  await expectPairingRejection(() => service.pair({ pcConfirmed: true }), 'PAIRING_TLS_PIN_MISMATCH');
  assert.equal(service.getState().status, 'failed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expectedTlsFingerprintSha256, FINGERPRINT);
  assert.equal(credentialStore.values.size, 0);
});

test('cancelling an in-flight issue ignores the late response and returns to idle', async () => {
  let resolveRequest;
  const pending = new Promise(resolve => {
    resolveRequest = resolve;
  });
  const credentialStore = memoryCredentialStore();
  const service = createPairingService({
    clock: { now: () => NOW },
    credentialStore,
    transport: { request: () => pending },
  });
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();

  const pairing = service.pair({ pcConfirmed: true });
  assert.equal(service.getState().status, 'issuing');
  await service.cancel();
  assert.deepEqual(service.getState(), { status: 'idle' });
  resolveRequest(response(200, credentialResponse()));

  await expectPairingRejection(() => pairing, 'PAIRING_CANCELLED');
  assert.equal(credentialStore.values.size, 0);
});

test('revocation removes protected identity and prevents credential reuse', async () => {
  const { credentialStore, service } = makeService();
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();
  await service.pair({ pcConfirmed: true });

  await service.markRevoked({ installationId: INSTALLATION_ID });

  assert.equal(credentialStore.values.has(pairingCredentialKey(INSTALLATION_ID)), false);
  assert.equal(credentialStore.values.has(pairingIdentityKey(INSTALLATION_ID)), false);
  assert.equal(service.getState().status, 'rejected');
  await expectPairingRejection(
    () => service.loadCredential({ installationId: INSTALLATION_ID }),
    'PAIRING_CREDENTIAL_REVOKED'
  );
});

test('protected-store failure enters the failed terminal state and removes partial writes', async () => {
  const values = new Map();
  const credentialStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
      throw new Error('keystore unavailable');
    },
    async remove(key) {
      values.delete(key);
    },
  };
  const service = createPairingService({
    clock: { now: () => NOW },
    credentialStore,
    transport: { request: async () => response(200, credentialResponse()) },
  });
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();

  await expectPairingRejection(() => service.pair({ pcConfirmed: true }), 'PAIRING_FAILED');
  assert.equal(service.getState().status, 'failed');
  assert.equal(values.size, 0);
});

test('malformed PC responses fail terminally without exposing or storing content', async () => {
  const { credentialStore, service } = makeService({
    replies: [
      {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<script>not JSON</script>',
      },
    ],
  });
  service.scan(qr(), { deviceName: 'Pixel 10' });
  service.awaitPcConfirmation();

  await expectPairingRejection(() => service.pair({ pcConfirmed: true }), 'PAIRING_FAILED');
  assert.equal(service.getState().status, 'failed');
  assert.equal(credentialStore.values.size, 0);
});
