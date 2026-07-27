export const ids = Object.freeze({
  profile: '5e83908d-e121-4c56-b7dc-6ee3d745cc30',
  reminder: '11ec785a-6677-4c35-8aef-2a01cb393533',
  challenge: 'challenge_FYB3D6mR6Yhs4jK9sGvQ2fE1',
  device: '6ba7b810-9dad-4d1f-80b4-00c04fd430c8',
  operation: '6ba7b811-9dad-4d1f-80b4-00c04fd430c8',
  operation2: '6ba7b812-9dad-4d1f-80b4-00c04fd430c8',
  entity: '6ba7b813-9dad-4d1f-80b4-00c04fd430c8',
  conflict: '6ba7b814-9dad-4d1f-80b4-00c04fd430c8',
  request: 'request_FYB3D6mR6Yhs4jK9',
  cursor: 'cursor_FYB3D6mR6Yhs4jK9sGvQ2fE1',
});

export const validFixtures = Object.freeze({
  error: {
    error: {
      code: 'cursor_expired',
      message: 'The sync cursor has expired.',
      requestId: ids.request,
      details: {},
    },
  },
  paginationRequest: { cursor: ids.cursor, limit: 50 },
  paginationResponse: {
    items: [{ id: ids.entity }],
    nextCursor: ids.cursor,
    hasMore: true,
  },
  health: {
    status: 'ok',
    version: '2.0.0',
    schemaVersion: 3,
    apiVersion: '1',
    mode: 'standalone',
    components: {
      database: { status: 'ready' },
      applicationApi: { status: 'ready' },
      scheduler: { status: 'disabled' },
      lanSync: { status: 'disabled' },
    },
    legacyMigrationAvailable: false,
  },
  reminderCreateRequest: {
    profileId: ids.profile,
    title: 'Review saved note',
    scheduledFor: 1_800_000_000_000,
    timezone: 'Asia/Kolkata',
  },
  reminderUpdateRequest: {
    expectedRevision: 0,
    transitionTo: 'due',
  },
  reminderResponse: {
    reminder: {
      reminderId: ids.reminder,
      profileId: ids.profile,
      title: 'Review saved note',
      scheduledFor: 1_800_000_000_000,
      timezone: 'Asia/Kolkata',
      state: 'scheduled',
      revision: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  },
  pairingChallengeRequest: {
    deviceName: 'Pixel',
    platform: 'android',
  },
  pairingChallengeResponse: {
    challengeId: ids.challenge,
    expiresAt: 1_800_000_000_000,
    status: 'pending_confirmation',
    oneUse: true,
  },
  pairingConfirmationRequest: {
    challengeId: ids.challenge,
    confirmed: true,
  },
  pairingCredentialIssueRequest: {
    challengeId: ids.challenge,
  },
  pairingCredentialResponse: {
    device: {
      deviceId: ids.device,
      name: 'Pixel',
      platform: 'android',
      status: 'active',
      createdAt: 1_700_000_000_000,
      lastSeenAt: null,
    },
    credential: {
      token: 'device_6Yhs4jK9sGvQ2fE1FYB3D6mR6Yhs4jK9',
      tokenType: 'Bearer',
      issuedAt: 1_700_000_000_000,
    },
  },
  pairingRevokeRequest: {
    deviceId: ids.device,
    reason: 'user_requested',
  },
  pairingRevokeResponse: {
    deviceId: ids.device,
    status: 'revoked',
    revokedAt: 1_700_000_000_000,
  },
  operation: {
    operationId: ids.operation,
    deviceId: ids.device,
    entityType: 'reminder',
    entityId: ids.entity,
    kind: 'upsert',
    baseRevision: 0,
    payload: { title: 'Review saved note', nested: { enabled: true } },
    occurredAt: 1_700_000_000_000,
  },
  syncPushResponse: {
    results: [{ operationId: ids.operation, status: 'accepted', revision: 1 }],
    serverTime: 1_700_000_000_000,
  },
});

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
