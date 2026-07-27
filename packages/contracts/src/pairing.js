import { createSchemaValidator } from './validation.js';

const PAIRING_SCHEMA_ID = 'https://contracts.easy-rewind.invalid/schema/pairing.json';

export const DEVICE_PLATFORMS = Object.freeze(['android']);
export const DEVICE_STATUSES = Object.freeze(['pending', 'active', 'revoked']);
export const PAIRING_REVOKE_REASONS = Object.freeze(['user_requested', 'credential_compromised', 'device_lost']);

export const validateDeviceIdentity = createSchemaValidator(`${PAIRING_SCHEMA_ID}#/$defs/DeviceIdentity`);
export const validatePairingChallengeRequest = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingChallengeRequest`
);
export const validatePairingChallengeResponse = createSchemaValidator(
  `${PAIRING_SCHEMA_ID}#/$defs/PairingChallengeResponse`
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
