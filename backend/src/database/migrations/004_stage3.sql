INSERT INTO sync_devices(
  id,
  profile_id,
  name,
  platform,
  state,
  created_at,
  updated_at,
  revision
)
SELECT
  'stage3-reminder-device-' || lower(hex(deliveries.profile_id)),
  deliveries.profile_id,
  'This PC',
  'windows',
  'active',
  MIN(deliveries.created_at),
  MIN(deliveries.created_at),
  1
FROM reminder_deliveries AS deliveries
WHERE NOT EXISTS (
  SELECT 1
  FROM sync_devices AS devices
  WHERE devices.profile_id = deliveries.profile_id
)
GROUP BY deliveries.profile_id;

CREATE TABLE reminder_deliveries_stage3 (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reminder_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('desktop', 'browser', 'email')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  scheduled_at INTEGER CHECK (scheduled_at IS NULL OR scheduled_at >= 0),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  FOREIGN KEY (profile_id, reminder_id) REFERENCES reminders(profile_id, id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE
);

INSERT INTO reminder_deliveries_stage3(
  id,
  profile_id,
  reminder_id,
  device_id,
  channel,
  state,
  attempt_count,
  scheduled_at,
  delivered_at,
  error_code,
  created_at,
  updated_at,
  revision,
  deleted_at
)
SELECT
  deliveries.id,
  deliveries.profile_id,
  deliveries.reminder_id,
  (
    SELECT devices.id
    FROM sync_devices AS devices
    WHERE devices.profile_id = deliveries.profile_id
    ORDER BY
      CASE devices.state WHEN 'active' THEN 0 ELSE 1 END,
      CASE devices.platform WHEN 'windows' THEN 0 ELSE 1 END,
      devices.id
    LIMIT 1
  ),
  deliveries.channel,
  deliveries.state,
  deliveries.attempt_count,
  deliveries.scheduled_at,
  deliveries.delivered_at,
  deliveries.error_code,
  deliveries.created_at,
  deliveries.updated_at,
  deliveries.revision,
  deliveries.deleted_at
FROM reminder_deliveries AS deliveries;

DROP TABLE reminder_deliveries;
ALTER TABLE reminder_deliveries_stage3 RENAME TO reminder_deliveries;

CREATE INDEX idx_reminder_deliveries_pending
  ON reminder_deliveries(profile_id, state, scheduled_at, attempt_count, id);
CREATE INDEX idx_reminder_deliveries_device_pending
  ON reminder_deliveries(profile_id, device_id, state, scheduled_at, attempt_count, id);
CREATE UNIQUE INDEX uq_reminder_deliveries_device_channel
  ON reminder_deliveries(profile_id, reminder_id, device_id, channel);

ALTER TABLE jobs ADD COLUMN lease_token TEXT CHECK (lease_token IS NULL OR lease_token <> '');
ALTER TABLE jobs ADD COLUMN lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0);
ALTER TABLE jobs ADD COLUMN heartbeat_at INTEGER CHECK (heartbeat_at IS NULL OR heartbeat_at >= 0);
ALTER TABLE jobs ADD COLUMN idempotency_key TEXT CHECK (idempotency_key IS NULL OR idempotency_key <> '');

ALTER TABLE sync_operations
  ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'upsert'
  CHECK (operation_type IN ('upsert', 'delete'));
ALTER TABLE sync_operations
  ADD COLUMN device_sequence INTEGER
  CHECK (device_sequence IS NULL OR device_sequence >= 1);
ALTER TABLE sync_operations
  ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1
  CHECK (protocol_version >= 1);
ALTER TABLE sync_operations
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1
  CHECK (schema_version >= 1);

ALTER TABLE sync_changes
  ADD COLUMN tombstone_expires_at INTEGER
  CHECK (
    tombstone_expires_at IS NULL
    OR (change_kind = 'delete' AND tombstone_expires_at >= created_at)
  );

ALTER TABLE sync_conflicts
  ADD COLUMN resolution_change_id TEXT REFERENCES sync_changes(id) ON DELETE SET NULL;

CREATE TABLE interactions (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('view', 'open', 'complete', 'dismiss', 'share')),
  value_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE memory_scores (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  last_interaction_at INTEGER CHECK (last_interaction_at IS NULL OR last_interaction_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  FOREIGN KEY (profile_id, item_id) REFERENCES items(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE sync_device_sequences (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE sync_acknowledgements (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied', 'rejected', 'conflict')),
  authoritative_revision INTEGER CHECK (authoritative_revision IS NULL OR authoritative_revision >= 1),
  change_sequence INTEGER CHECK (change_sequence IS NULL OR change_sequence >= 1),
  response_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, operation_id) REFERENCES sync_operations(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE sync_snapshots (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  base_sequence INTEGER NOT NULL CHECK (base_sequence >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'consumed', 'expired', 'failed')),
  checksum TEXT CHECK (
    checksum IS NULL
    OR (length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*')
  ),
  payload_json TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id, device_id) REFERENCES sync_devices(profile_id, id) ON DELETE CASCADE
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  state TEXT NOT NULL CHECK (
    state IN ('dry_run', 'ready', 'running', 'succeeded', 'failed', 'rolled_back', 'cancelled')
  ),
  source_checksum TEXT NOT NULL CHECK (
    length(source_checksum) = 64 AND source_checksum NOT GLOB '*[^a-f0-9]*'
  ),
  backup_ref TEXT CHECK (backup_ref IS NULL OR backup_ref <> ''),
  report_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= started_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE export_runs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  format_version INTEGER NOT NULL CHECK (format_version >= 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled')),
  artifact_ref TEXT CHECK (artifact_ref IS NULL OR artifact_ref <> ''),
  checksum TEXT CHECK (
    checksum IS NULL
    OR (length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*')
  ),
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  error_code TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= started_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE provider_configurations (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider <> ''),
  model TEXT NOT NULL CHECK (model <> ''),
  state TEXT NOT NULL CHECK (state IN ('configured', 'disabled', 'error')),
  secret_ref TEXT CHECK (secret_ref IS NULL OR secret_ref <> ''),
  settings_json TEXT NOT NULL DEFAULT '{}',
  last_tested_at INTEGER CHECK (last_tested_at IS NULL OR last_tested_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE UNIQUE INDEX uq_jobs_profile_idempotency
  ON jobs(profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_jobs_profile_lease
  ON jobs(profile_id, state, lease_expires_at, available_at, id);

CREATE UNIQUE INDEX uq_sync_operations_device_sequence
  ON sync_operations(profile_id, device_id, device_sequence)
  WHERE device_id IS NOT NULL AND device_sequence IS NOT NULL;
CREATE INDEX idx_sync_changes_tombstone_retention
  ON sync_changes(profile_id, change_kind, tombstone_expires_at, sequence);
CREATE INDEX idx_sync_conflicts_resolution_change
  ON sync_conflicts(profile_id, resolution_change_id);

CREATE INDEX idx_interactions_profile_item
  ON interactions(profile_id, item_id, deleted_at, occurred_at DESC, id);
CREATE INDEX idx_interactions_profile_occurred
  ON interactions(profile_id, deleted_at, occurred_at DESC, id);
CREATE UNIQUE INDEX uq_memory_scores_live_item
  ON memory_scores(profile_id, item_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_memory_scores_profile_score
  ON memory_scores(profile_id, deleted_at, score DESC, updated_at DESC, id);
CREATE UNIQUE INDEX uq_sync_device_sequences_device
  ON sync_device_sequences(profile_id, device_id);
CREATE UNIQUE INDEX uq_sync_acknowledgements_operation
  ON sync_acknowledgements(profile_id, operation_id);
CREATE INDEX idx_sync_acknowledgements_profile_device
  ON sync_acknowledgements(profile_id, device_id, created_at, id);
CREATE INDEX idx_sync_snapshots_profile_device
  ON sync_snapshots(profile_id, device_id, state, expires_at, id);
CREATE INDEX idx_import_runs_profile_state
  ON import_runs(profile_id, state, created_at DESC, id);
CREATE INDEX idx_export_runs_profile_state
  ON export_runs(profile_id, state, created_at DESC, id);
CREATE UNIQUE INDEX uq_provider_configurations_live_provider
  ON provider_configurations(profile_id, provider)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_provider_configurations_profile_state
  ON provider_configurations(profile_id, state, deleted_at, updated_at DESC, id);

CREATE TRIGGER sync_conflicts_resolution_owner_insert
BEFORE INSERT ON sync_conflicts
WHEN NEW.resolution_change_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM sync_changes
    WHERE id = NEW.resolution_change_id AND profile_id = NEW.profile_id
  )
BEGIN
  SELECT RAISE(ABORT, 'sync conflict resolution owner mismatch');
END;

CREATE TRIGGER sync_conflicts_resolution_owner_update
BEFORE UPDATE OF profile_id, resolution_change_id ON sync_conflicts
WHEN NEW.resolution_change_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM sync_changes
    WHERE id = NEW.resolution_change_id AND profile_id = NEW.profile_id
  )
BEGIN
  SELECT RAISE(ABORT, 'sync conflict resolution owner mismatch');
END;
