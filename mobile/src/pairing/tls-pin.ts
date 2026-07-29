import type { PinnedTransportRequest } from '../platform/ports.ts';

const TLS_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class TlsPinMismatchError extends Error {
  readonly code = 'TLS_PIN_MISMATCH';
  readonly expected: string;
  readonly observed: string;

  constructor(expected: string, observed: string) {
    super('The paired PC TLS identity does not match the pinned identity.');
    this.name = 'TlsPinMismatchError';
    this.expected = expected;
    this.observed = observed;
  }
}

export function assertTlsFingerprint(expected: string, observed: string): string {
  if (!TLS_FINGERPRINT_PATTERN.test(expected) || !TLS_FINGERPRINT_PATTERN.test(observed) || expected !== observed) {
    throw new TlsPinMismatchError(expected, observed);
  }
  return expected;
}

function pairingBootstrapUrl(syncEndpoint: string): string {
  const parsed = new URL(syncEndpoint);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/v1/sync' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('The pairing sync endpoint is invalid.');
  }
  parsed.pathname = '/v1/pairing/bootstrap';
  return parsed.toString();
}

export function createPinnedPairingRequest({
  syncEndpoint,
  tlsFingerprint,
  body,
}: {
  readonly syncEndpoint: string;
  readonly tlsFingerprint: string;
  readonly body: Readonly<Record<string, unknown>>;
}): Readonly<PinnedTransportRequest> {
  if (!TLS_FINGERPRINT_PATTERN.test(tlsFingerprint)) {
    throw new TypeError('The pairing TLS fingerprint is invalid.');
  }
  const headers = Object.freeze({ 'content-type': 'application/json' });
  return Object.freeze({
    url: pairingBootstrapUrl(syncEndpoint),
    method: 'POST',
    expectedTlsFingerprintSha256: tlsFingerprint,
    headers,
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });
}
