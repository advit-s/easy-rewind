import { createSchemaValidator } from './validation.js';

const PAIRING_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/pairing.json';

export const DEVICE_PLATFORMS = Object.freeze(['android']);
export const DEVICE_STATUSES = Object.freeze(['pending', 'active', 'revoked']);
export const PAIRING_REVOKE_REASONS = Object.freeze(['user_requested', 'credential_compromised', 'device_lost']);
export const PAIRING_PROTOCOL_VERSION = '1';

function isPrivateIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

function isPrivateIpv6(host) {
  const lower = host.toLowerCase();
  return /^f[cd][0-9a-f]{0,2}:/.test(lower) || /^fe[89ab][0-9a-f]?:/.test(lower);
}

function isLocalHostname(host) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/i.test(host);
}

function isPrivateSyncEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  const match = /^https:\/\/(\[[^\]]+\]|[^/:?#]+):([0-9]{1,5})(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(endpoint);
  if (!match) return false;
  const [, authorityHost, portText, path = '/', query, fragment] = match;
  const port = Number(portText);
  if (port < 1 || port > 65_535 || path !== '/v1/sync' || query || fragment) return false;

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

  if (authorityHost.startsWith('[')) {
    return isPrivateIpv6(authorityHost.slice(1, -1));
  }
  return isPrivateIpv4(authorityHost) || isLocalHostname(authorityHost);
}

export const validateDeviceIdentity = createSchemaValidator(`${PAIRING_SCHEMA_ID}#/$defs/DeviceIdentity`);
export const validatePairingChallengeRequest = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingChallengeRequest`
);
export const validatePairingChallengeResponse = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingChallengeResponse`,
  {
    postvalidate(value) {
      return (
        isPrivateSyncEndpoint(value.qrPayload.syncEndpoint) &&
        value.qrPayload.challengeId === value.challengeId &&
        value.qrPayload.expiresAt === value.expiresAt
      );
    },
  }
);
export const validatePairingConfirmationRequest = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingConfirmationRequest`
);
export const validatePairingCredentialIssueRequest = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingCredentialIssueRequest`
);
export const validatePairingCredentialResponse = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingCredentialResponse`
);
export const validatePairingRevokeRequest = createSchemaValidator(`${PAIRING_SCHEMA_ID}#/$defs/PairingRevokeRequest`);
export const validatePairingRevokeResponse = createSchemaValidator(`${PAIRING_SCHEMA_ID}#/$defs/PairingRevokeResponse`);
