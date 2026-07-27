CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind <> ''),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  available_at INTEGER NOT NULL DEFAULT 0 CHECK (available_at >= 0),
  locked_at INTEGER CHECK (locked_at IS NULL OR locked_at >= 0),
  locked_by TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES sync_devices(id) ON DELETE SET NULL,
  operation_key TEXT NOT NULL CHECK (operation_key <> ''),
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'rejected')),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE sync_changes (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operation_id TEXT REFERENCES sync_operations(id) ON DELETE SET NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  entity_revision INTEGER NOT NULL CHECK (entity_revision >= 1),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('upsert', 'delete')),
  payload_json TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE sync_cursors (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES sync_devices(id) ON DELETE CASCADE,
  peer_device_id TEXT NOT NULL REFERENCES sync_devices(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (device_id <> peer_device_id)
);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type <> ''),
  entity_id TEXT NOT NULL CHECK (entity_id <> ''),
  local_revision INTEGER NOT NULL CHECK (local_revision >= 1),
  remote_revision INTEGER NOT NULL CHECK (remote_revision >= 1),
  local_payload_json TEXT,
  remote_payload_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved_local', 'resolved_remote', 'resolved_merged')),
  resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  from_version INTEGER NOT NULL CHECK (from_version >= 0),
  to_version INTEGER NOT NULL CHECK (to_version >= from_version),
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  error_code TEXT,
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= started_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE INDEX idx_jobs_profile_state_available ON jobs(profile_id, state, available_at, attempts, id);
CREATE UNIQUE INDEX uq_sync_operations_profile_operation ON sync_operations(profile_id, operation_key);
CREATE INDEX idx_sync_operations_profile_created ON sync_operations(profile_id, state, created_at, id);
CREATE INDEX idx_sync_operations_device_state ON sync_operations(device_id, state, created_at, id);
CREATE UNIQUE INDEX uq_sync_changes_profile_sequence ON sync_changes(profile_id, sequence);
CREATE INDEX idx_sync_changes_profile_entity ON sync_changes(profile_id, entity_type, entity_id, entity_revision DESC);
CREATE UNIQUE INDEX uq_sync_cursors_devices ON sync_cursors(profile_id, device_id, peer_device_id);
CREATE INDEX idx_sync_cursors_profile_device ON sync_cursors(profile_id, device_id, peer_device_id, last_sequence);
CREATE INDEX idx_sync_conflicts_profile_state ON sync_conflicts(profile_id, state, updated_at, id);
CREATE UNIQUE INDEX uq_sync_conflicts_open_entity ON sync_conflicts(profile_id, entity_type, entity_id) WHERE state = 'open';
CREATE INDEX idx_migration_runs_state ON migration_runs(state, started_at, id);
