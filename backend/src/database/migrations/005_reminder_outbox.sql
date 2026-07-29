ALTER TABLE reminder_deliveries
  ADD COLUMN acknowledged_at INTEGER
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0);

CREATE INDEX idx_reminder_deliveries_device_outbox
  ON reminder_deliveries(profile_id, device_id, channel, state, acknowledged_at, updated_at, id);
