import type { Clock, PinnedTransport, PinnedTransportResponse, SecureCredentialStore } from '../platform/ports.ts';
import { PAIRING_PROTOCOL_VERSION, PairingError, parsePairingQrPayload, type PairingQrPayload } from './qr-payload.ts';
import { TlsPinMismatchError, createPinnedPairingRequest } from './tls-pin.ts';

export { PairingError } from './qr-payload.ts';

const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{31,511}$/;

export type PairingStatus =
  'idle' | 'scanned' | 'awaiting_confirmation' | 'issuing' | 'paired' | 'expired' | 'rejected' | 'failed';

export type PairingState =
  | Readonly<{ status: 'idle' }>
  | Readonly<{
      status: 'scanned' | 'awaiting_confirmation' | 'issuing';
      deviceName: string;
      installationId: string;
      expiresAt: number;
    }>
  | Readonly<{
      status: 'paired';
      deviceId: string;
      deviceName: string;
      installationId: string;
    }>
  | Readonly<{ status: 'expired' | 'rejected' | 'failed'; code: string }>;

interface PairingDeviceResponse {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: 'android';
  readonly status: 'active';
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
}

interface PairingCredentialResponse {
  readonly device: PairingDeviceResponse;
  readonly credential: Readonly<{
    token: string;
    tokenType: 'Bearer';
    issuedAt: number;
  }>;
}

interface PairingIdentity {
  readonly protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  readonly syncEndpoint: string;
  readonly tlsFingerprint: string;
  readonly installationId: string;
  readonly deviceId: string;
  readonly deviceName: string;
}

const idleState = Object.freeze({ status: 'idle' } as const);

function terminalState(
  status: 'expired' | 'rejected' | 'failed',
  code: string
): Readonly<{ status: 'expired' | 'rejected' | 'failed'; code: string }> {
  return Object.freeze({ status, code });
}

function activeState(
  status: 'scanned' | 'awaiting_confirmation' | 'issuing',
  payload: PairingQrPayload,
  deviceName: string
): PairingState {
  return Object.freeze({
    status,
    deviceName,
    installationId: payload.installationId,
    expiresAt: payload.expiresAt,
  });
}

function fail(code: ConstructorParameters<typeof PairingError>[0], message: string): never {
  throw new PairingError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseResponseJson(response: PinnedTransportResponse): unknown {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.body !== 'string' ||
    response.body.length > 64 * 1_024
  ) {
    fail('PAIRING_FAILED', 'The pairing response is invalid.');
  }
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    fail('PAIRING_FAILED', 'The pairing response is invalid.');
  }
}

function parseCredentialResponse(response: PinnedTransportResponse, deviceName: string): PairingCredentialResponse {
  const value = parseResponseJson(response);
  if (
    !isPlainObject(value) ||
    !exactKeys(value, ['credential', 'device']) ||
    !isPlainObject(value.device) ||
    !exactKeys(value.device, ['createdAt', 'deviceId', 'lastSeenAt', 'name', 'platform', 'status']) ||
    typeof value.device.deviceId !== 'string' ||
    !DEVICE_ID_PATTERN.test(value.device.deviceId) ||
    value.device.name !== deviceName ||
    value.device.platform !== 'android' ||
    value.device.status !== 'active' ||
    !Number.isSafeInteger(value.device.createdAt) ||
    (value.device.createdAt as number) < 0 ||
    !(
      value.device.lastSeenAt === null ||
      (Number.isSafeInteger(value.device.lastSeenAt) && (value.device.lastSeenAt as number) >= 0)
    ) ||
    !isPlainObject(value.credential) ||
    !exactKeys(value.credential, ['issuedAt', 'token', 'tokenType']) ||
    typeof value.credential.token !== 'string' ||
    !TOKEN_PATTERN.test(value.credential.token) ||
    value.credential.tokenType !== 'Bearer' ||
    !Number.isSafeInteger(value.credential.issuedAt) ||
    (value.credential.issuedAt as number) < 0
  ) {
    fail('PAIRING_CREDENTIAL_INVALID', 'The paired-device credential response is invalid.');
  }
  return value as unknown as PairingCredentialResponse;
}

function serverError(response: PinnedTransportResponse): {
  readonly code: string;
  readonly status: 'awaiting_confirmation' | 'expired' | 'rejected' | 'failed';
  readonly pairingCode:
    | 'PAIRING_PC_CONFIRMATION_REQUIRED'
    | 'PAIRING_CHALLENGE_EXPIRED'
    | 'PAIRING_REJECTED'
    | 'PAIRING_CREDENTIAL_REVOKED'
    | 'PAIRING_FAILED';
} {
  const value = parseResponseJson(response);
  const reported =
    isPlainObject(value) && isPlainObject(value.error) && typeof value.error.code === 'string'
      ? value.error.code.toLowerCase()
      : '';
  if (response.status === 409 || reported.includes('confirmation')) {
    return {
      code: 'PAIRING_PC_CONFIRMATION_REQUIRED',
      status: 'awaiting_confirmation',
      pairingCode: 'PAIRING_PC_CONFIRMATION_REQUIRED',
    };
  }
  if (response.status === 410 || reported.includes('expired')) {
    return {
      code: 'PAIRING_CHALLENGE_EXPIRED',
      status: 'expired',
      pairingCode: 'PAIRING_CHALLENGE_EXPIRED',
    };
  }
  if (response.status === 401 || reported.includes('revoked')) {
    return {
      code: 'PAIRING_CREDENTIAL_REVOKED',
      status: 'rejected',
      pairingCode: 'PAIRING_CREDENTIAL_REVOKED',
    };
  }
  if (response.status === 403 || reported.includes('reject')) {
    return {
      code: 'PAIRING_REJECTED',
      status: 'rejected',
      pairingCode: 'PAIRING_REJECTED',
    };
  }
  return { code: 'PAIRING_FAILED', status: 'failed', pairingCode: 'PAIRING_FAILED' };
}

function validateDependencies({
  clock,
  credentialStore,
  transport,
}: {
  readonly clock: Clock;
  readonly credentialStore: SecureCredentialStore;
  readonly transport: PinnedTransport;
}): void {
  if (
    clock === null ||
    typeof clock !== 'object' ||
    typeof clock.now !== 'function' ||
    credentialStore === null ||
    typeof credentialStore !== 'object' ||
    typeof credentialStore.get !== 'function' ||
    typeof credentialStore.set !== 'function' ||
    typeof credentialStore.remove !== 'function' ||
    transport === null ||
    typeof transport !== 'object' ||
    typeof transport.request !== 'function'
  ) {
    throw new TypeError('Pairing dependencies are invalid.');
  }
}

function validatedInstallationId(installationId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{15,255}$/.test(installationId)) {
    throw new TypeError('The pairing installation identifier is invalid.');
  }
  return installationId;
}

export function pairingCredentialKey(installationId: string): string {
  return `easy-rewind/pairing/${validatedInstallationId(installationId)}/credential`;
}

export function pairingIdentityKey(installationId: string): string {
  return `easy-rewind/pairing/${validatedInstallationId(installationId)}/identity`;
}

export function createPairingService({
  clock,
  credentialStore,
  transport,
}: {
  readonly clock: Clock;
  readonly credentialStore: SecureCredentialStore;
  readonly transport: PinnedTransport;
}) {
  validateDependencies({ clock, credentialStore, transport });

  let state: PairingState = idleState;
  let payload: PairingQrPayload | undefined;
  let pendingDeviceName: string | undefined;
  let operationGeneration = 0;
  const consumedChallenges = new Set<string>();
  const revokedInstallations = new Set<string>();

  function getState(): PairingState {
    return state;
  }

  function requireActive(): { readonly payload: PairingQrPayload; readonly deviceName: string } {
    if (payload === undefined || pendingDeviceName === undefined) {
      fail('PAIRING_STATE_INVALID', 'The pairing state is invalid.');
    }
    return { payload, deviceName: pendingDeviceName };
  }

  function expire(activePayload: PairingQrPayload): void {
    if (activePayload.expiresAt <= clock.now()) {
      consumedChallenges.add(activePayload.challengeId);
      state = terminalState('expired', 'PAIRING_CHALLENGE_EXPIRED');
      fail('PAIRING_CHALLENGE_EXPIRED', 'The pairing challenge has expired.');
    }
  }

  function scan(input: unknown, { deviceName }: { readonly deviceName: string }): PairingState {
    if (state.status !== 'idle') {
      fail('PAIRING_STATE_INVALID', 'Pairing can only scan from the idle state.');
    }
    if (typeof deviceName !== 'string' || deviceName.trim().length < 1 || deviceName.trim().length > 64) {
      fail('PAIRING_DEVICE_NAME_INVALID', 'The paired device name is invalid.');
    }
    const parsed = parsePairingQrPayload(input, { now: clock.now() });
    if (consumedChallenges.has(parsed.challengeId)) {
      fail('PAIRING_CHALLENGE_CONSUMED', 'The pairing challenge has already been used.');
    }
    if (revokedInstallations.has(parsed.installationId)) {
      fail('PAIRING_CREDENTIAL_REVOKED', 'The paired-device credential has been revoked.');
    }
    payload = parsed;
    pendingDeviceName = deviceName.trim();
    state = activeState('scanned', parsed, pendingDeviceName);
    return state;
  }

  function awaitPcConfirmation(): PairingState {
    if (state.status !== 'scanned') {
      fail('PAIRING_STATE_INVALID', 'The scanned challenge is not ready for confirmation.');
    }
    const active = requireActive();
    expire(active.payload);
    state = activeState('awaiting_confirmation', active.payload, active.deviceName);
    return state;
  }

  async function removeProtectedPairing(installationId: string): Promise<void> {
    await Promise.allSettled([
      credentialStore.remove(pairingCredentialKey(installationId)),
      credentialStore.remove(pairingIdentityKey(installationId)),
    ]);
  }

  function ensureCurrent(generation: number): void {
    if (generation !== operationGeneration || state.status !== 'issuing') {
      fail('PAIRING_CANCELLED', 'Pairing was cancelled.');
    }
  }

  async function persistCredential({
    activePayload,
    credentialResponse,
    deviceName,
    generation,
  }: {
    readonly activePayload: PairingQrPayload;
    readonly credentialResponse: PairingCredentialResponse;
    readonly deviceName: string;
    readonly generation: number;
  }): Promise<void> {
    const credentialKey = pairingCredentialKey(activePayload.installationId);
    const identityKey = pairingIdentityKey(activePayload.installationId);
    const identity: PairingIdentity = Object.freeze({
      protocolVersion: PAIRING_PROTOCOL_VERSION,
      syncEndpoint: activePayload.syncEndpoint,
      tlsFingerprint: activePayload.tlsFingerprint,
      installationId: activePayload.installationId,
      deviceId: credentialResponse.device.deviceId,
      deviceName,
    });
    try {
      await credentialStore.set(credentialKey, credentialResponse.credential.token);
      ensureCurrent(generation);
      await credentialStore.set(identityKey, JSON.stringify(identity));
      ensureCurrent(generation);
    } catch (error) {
      await removeProtectedPairing(activePayload.installationId);
      if (error instanceof PairingError) throw error;
      fail('PAIRING_FAILED', 'The paired-device credential could not be protected.');
    }
  }

  async function pair({ pcConfirmed }: { readonly pcConfirmed: boolean }): Promise<PairingState> {
    if (state.status !== 'awaiting_confirmation') {
      fail('PAIRING_STATE_INVALID', 'Pairing is not awaiting PC confirmation.');
    }
    const active = requireActive();
    expire(active.payload);
    if (pcConfirmed !== true) {
      fail('PAIRING_PC_CONFIRMATION_REQUIRED', 'Explicit confirmation on the PC is required.');
    }

    const generation = ++operationGeneration;
    state = activeState('issuing', active.payload, active.deviceName);
    let response: PinnedTransportResponse;
    try {
      response = await transport.request(
        createPinnedPairingRequest({
          syncEndpoint: active.payload.syncEndpoint,
          tlsFingerprint: active.payload.tlsFingerprint,
          body: Object.freeze({
            action: 'issue',
            challengeId: active.payload.challengeId,
            installationId: active.payload.installationId,
          }),
        })
      );
      ensureCurrent(generation);
    } catch (error) {
      if (error instanceof PairingError) throw error;
      if (error instanceof TlsPinMismatchError || (isPlainObject(error) && error.code === 'TLS_PIN_MISMATCH')) {
        state = terminalState('failed', 'PAIRING_TLS_PIN_MISMATCH');
        fail('PAIRING_TLS_PIN_MISMATCH', 'The paired PC TLS identity does not match.');
      }
      state = terminalState('failed', 'PAIRING_FAILED');
      fail('PAIRING_FAILED', 'The pairing request failed.');
    }

    if (response.status < 200 || response.status >= 300) {
      const mapped = serverError(response);
      if (mapped.status === 'awaiting_confirmation') {
        state = activeState('awaiting_confirmation', active.payload, active.deviceName);
      } else {
        state = terminalState(mapped.status, mapped.code);
      }
      if (mapped.pairingCode === 'PAIRING_CREDENTIAL_REVOKED') {
        revokedInstallations.add(active.payload.installationId);
        await removeProtectedPairing(active.payload.installationId);
      }
      fail(mapped.pairingCode, 'The paired PC did not issue a credential.');
    }

    let credentialResponse: PairingCredentialResponse;
    try {
      credentialResponse = parseCredentialResponse(response, active.deviceName);
    } catch (error) {
      state = terminalState('failed', error instanceof PairingError ? error.code : 'PAIRING_FAILED');
      throw error;
    }
    consumedChallenges.add(active.payload.challengeId);
    try {
      await persistCredential({
        activePayload: active.payload,
        credentialResponse,
        deviceName: active.deviceName,
        generation,
      });
    } catch (error) {
      if (generation === operationGeneration && state.status === 'issuing') {
        state = terminalState('failed', error instanceof PairingError ? error.code : 'PAIRING_FAILED');
      }
      throw error;
    }
    ensureCurrent(generation);
    state = Object.freeze({
      status: 'paired',
      deviceId: credentialResponse.device.deviceId,
      deviceName: active.deviceName,
      installationId: active.payload.installationId,
    });
    return state;
  }

  async function cancel(): Promise<void> {
    const activePayload = payload;
    operationGeneration += 1;
    payload = undefined;
    pendingDeviceName = undefined;
    state = idleState;
    if (activePayload !== undefined) {
      await removeProtectedPairing(activePayload.installationId);
    }
  }

  function reset(): PairingState {
    if (!['paired', 'expired', 'rejected', 'failed'].includes(state.status)) {
      fail('PAIRING_STATE_INVALID', 'The active pairing attempt must be cancelled.');
    }
    operationGeneration += 1;
    payload = undefined;
    pendingDeviceName = undefined;
    state = idleState;
    return state;
  }

  async function markRevoked({ installationId }: { readonly installationId: string }): Promise<void> {
    validatedInstallationId(installationId);
    revokedInstallations.add(installationId);
    operationGeneration += 1;
    await removeProtectedPairing(installationId);
    if (
      payload?.installationId === installationId ||
      (state.status === 'paired' && state.installationId === installationId)
    ) {
      state = terminalState('rejected', 'PAIRING_CREDENTIAL_REVOKED');
      payload = undefined;
      pendingDeviceName = undefined;
    }
  }

  async function loadCredential({ installationId }: { readonly installationId: string }): Promise<string> {
    validatedInstallationId(installationId);
    if (revokedInstallations.has(installationId)) {
      fail('PAIRING_CREDENTIAL_REVOKED', 'The paired-device credential has been revoked.');
    }
    const token = await credentialStore.get(pairingCredentialKey(installationId));
    if (token === null || !TOKEN_PATTERN.test(token)) {
      fail('PAIRING_CREDENTIAL_INVALID', 'The paired-device credential is unavailable.');
    }
    return token;
  }

  return Object.freeze({
    awaitPcConfirmation,
    cancel,
    getState,
    loadCredential,
    markRevoked,
    pair,
    reset,
    scan,
  });
}
