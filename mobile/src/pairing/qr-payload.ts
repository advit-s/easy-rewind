export const PAIRING_PROTOCOL_VERSION = '1' as const;

const QR_FIELDS = Object.freeze([
  'challengeId',
  'expiresAt',
  'installationId',
  'protocolVersion',
  'syncEndpoint',
  'tlsFingerprint',
] as const);
const OPAQUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{15,255}$/;
const TLS_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type PairingErrorCode =
  | 'PAIRING_CANCELLED'
  | 'PAIRING_CHALLENGE_CONSUMED'
  | 'PAIRING_CHALLENGE_EXPIRED'
  | 'PAIRING_CREDENTIAL_INVALID'
  | 'PAIRING_CREDENTIAL_REVOKED'
  | 'PAIRING_DEVICE_NAME_INVALID'
  | 'PAIRING_FAILED'
  | 'PAIRING_PC_CONFIRMATION_REQUIRED'
  | 'PAIRING_PROTOCOL_UNSUPPORTED'
  | 'PAIRING_QR_INVALID'
  | 'PAIRING_REJECTED'
  | 'PAIRING_STATE_INVALID'
  | 'PAIRING_TLS_PIN_MISMATCH';

export class PairingError extends Error {
  readonly code: PairingErrorCode;

  constructor(code: PairingErrorCode, message: string) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

export interface PairingQrPayload {
  readonly protocolVersion: typeof PAIRING_PROTOCOL_VERSION;
  readonly syncEndpoint: string;
  readonly tlsFingerprint: string;
  readonly installationId: string;
  readonly challengeId: string;
  readonly expiresAt: number;
}

function fail(code: PairingErrorCode, message: string): never {
  throw new PairingError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  const firstHextet = host.toLowerCase().split(':', 1)[0];
  if (firstHextet === undefined || !/^[0-9a-f]{1,4}$/.test(firstHextet)) return false;
  const value = Number.parseInt(firstHextet, 16);
  return value >= 0xfc00 && value <= 0xfdff;
}

function isLocalHostname(host: string): boolean {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(host);
}

function isPrivateSyncEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length < 20 || endpoint.length > 512) return false;
  const match = /^https:\/\/(\[[^\]]+\]|[^/:?#]+):([0-9]{1,5})(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(endpoint);
  if (match === null) return false;
  const authorityHost = match[1];
  const portText = match[2];
  const path = match[3] ?? '/';
  const query = match[4];
  const fragment = match[5];
  if (authorityHost === undefined || portText === undefined) return false;
  const port = Number(portText);
  if (port < 1 || port > 65_535 || path !== '/v1/sync' || query !== undefined || fragment !== undefined) {
    return false;
  }

  try {
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return false;
    }
  } catch {
    return false;
  }

  if (authorityHost.startsWith('[') && authorityHost.endsWith(']')) {
    return isPrivateIpv6(authorityHost.slice(1, -1));
  }
  return isPrivateIpv4(authorityHost) || isLocalHostname(authorityHost);
}

function decodePayload(input: unknown): Record<string, unknown> {
  let decoded = input;
  if (typeof input === 'string') {
    if (input.length < 2 || input.length > 2_048) {
      fail('PAIRING_QR_INVALID', 'The pairing QR payload is invalid.');
    }
    try {
      decoded = JSON.parse(input) as unknown;
    } catch {
      fail('PAIRING_QR_INVALID', 'The pairing QR payload is invalid.');
    }
  }
  if (!isPlainObject(decoded)) {
    fail('PAIRING_QR_INVALID', 'The pairing QR payload is invalid.');
  }
  return decoded;
}

export function parsePairingQrPayload(input: unknown, { now }: { readonly now: number }): Readonly<PairingQrPayload> {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('The pairing clock is invalid.');
  }
  const decoded = decodePayload(input);
  const keys = Object.keys(decoded).sort();
  if (keys.length !== QR_FIELDS.length || keys.some((key, index) => key !== QR_FIELDS[index])) {
    fail('PAIRING_QR_INVALID', 'The pairing QR payload fields are invalid.');
  }
  if (decoded.protocolVersion !== PAIRING_PROTOCOL_VERSION) {
    fail('PAIRING_PROTOCOL_UNSUPPORTED', 'The pairing protocol version is not supported.');
  }
  if (
    !isPrivateSyncEndpoint(decoded.syncEndpoint) ||
    typeof decoded.tlsFingerprint !== 'string' ||
    !TLS_FINGERPRINT_PATTERN.test(decoded.tlsFingerprint) ||
    typeof decoded.installationId !== 'string' ||
    !OPAQUE_ID_PATTERN.test(decoded.installationId) ||
    typeof decoded.challengeId !== 'string' ||
    !OPAQUE_ID_PATTERN.test(decoded.challengeId) ||
    !Number.isSafeInteger(decoded.expiresAt) ||
    (decoded.expiresAt as number) < 0
  ) {
    fail('PAIRING_QR_INVALID', 'The pairing QR payload is invalid.');
  }
  if ((decoded.expiresAt as number) <= now) {
    fail('PAIRING_CHALLENGE_EXPIRED', 'The pairing challenge has expired.');
  }

  return Object.freeze({
    protocolVersion: PAIRING_PROTOCOL_VERSION,
    syncEndpoint: decoded.syncEndpoint,
    tlsFingerprint: decoded.tlsFingerprint,
    installationId: decoded.installationId,
    challengeId: decoded.challengeId,
    expiresAt: decoded.expiresAt as number,
  });
}
