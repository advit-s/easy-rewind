CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  platform TEXT NOT NULL CHECK (platform IN ('browser', 'windows', 'android')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  public_key TEXT,
  paired_at INTEGER CHECK (paired_at IS NULL OR paired_at >= 0),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE UNIQUE INDEX uq_sync_devices_profile_id ON sync_devices(profile_id, id);

CREATE TABLE client_credentials (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('application_api', 'browser_extension', 'sync_device')),
  device_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  secret_ref TEXT UNIQUE CHECK (secret_ref IS NULL OR secret_ref <> ''),
  secret_digest TEXT NOT NULL UNIQUE CHECK (
    length(secret_digest) = 67
    AND substr(secret_digest, 1, 3) = 'v1:'
    AND substr(secret_digest, 4) NOT GLOB '*[^a-f0-9]*'
  ),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_client_credentials_profile_id ON client_credentials(profile_id, id);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin <> ''),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 67
    AND substr(token_hash, 1, 3) = 'v1:'
    AND substr(token_hash, 4) NOT GLOB '*[^a-f0-9]*'
  ),
  csrf_hash TEXT NOT NULL UNIQUE CHECK (
    length(csrf_hash) = 67
    AND substr(csrf_hash, 1, 3) = 'v1:'
    AND substr(csrf_hash, 4) NOT GLOB '*[^a-f0-9]*'
  ),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, credential_id) REFERENCES client_credentials(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE pairing_challenges (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  challenge_digest TEXT NOT NULL UNIQUE CHECK (
    length(challenge_digest) = 67
    AND substr(challenge_digest, 1, 3) = 'v1:'
    AND substr(challenge_digest, 4) NOT GLOB '*[^a-f0-9]*'
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'consumed', 'expired')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= 0),
  consumed_at INTEGER CHECK (consumed_at IS NULL OR consumed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_browser_sessions_profile_state ON browser_sessions(profile_id, state, expires_at, id);
CREATE INDEX idx_client_credentials_profile_state ON client_credentials(profile_id, state, kind, id);
CREATE INDEX idx_sync_devices_profile_state ON sync_devices(profile_id, state, deleted_at, updated_at DESC, id);
CREATE INDEX idx_pairing_challenges_profile_state
  ON pairing_challenges(profile_id, state, expires_at, id);
