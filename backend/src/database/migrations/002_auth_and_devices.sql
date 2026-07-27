CREATE TABLE client_credentials (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('application_api', 'browser_extension', 'sync_device')),
  label TEXT NOT NULL DEFAULT '',
  secret_ref TEXT NOT NULL UNIQUE CHECK (secret_ref <> ''),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  last_used_at INTEGER CHECK (last_used_at IS NULL OR last_used_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash <> ''),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, credential_id) REFERENCES client_credentials(profile_id, id) ON DELETE CASCADE
);

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

CREATE INDEX idx_browser_sessions_profile_state ON browser_sessions(profile_id, state, expires_at, id);
CREATE INDEX idx_client_credentials_profile_state ON client_credentials(profile_id, state, kind, id);
CREATE UNIQUE INDEX uq_client_credentials_profile_id ON client_credentials(profile_id, id);
CREATE INDEX idx_sync_devices_profile_state ON sync_devices(profile_id, state, deleted_at, updated_at DESC, id);
CREATE UNIQUE INDEX uq_sync_devices_profile_id ON sync_devices(profile_id, id);
