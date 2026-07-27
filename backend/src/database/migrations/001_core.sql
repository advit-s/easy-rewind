CREATE TABLE profiles (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  display_name TEXT NOT NULL CHECK (display_name <> ''),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone <> ''),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale <> ''),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('article', 'webpage', 'video', 'pdf', 'note')),
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  source TEXT,
  published_at INTEGER CHECK (published_at IS NULL OR published_at >= 0),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE bookmarks (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  quote TEXT NOT NULL CHECK (quote <> ''),
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow' CHECK (color IN ('yellow', 'green', 'blue', 'pink', 'purple')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name <> ''),
  normalized_name TEXT NOT NULL CHECK (normalized_name <> ''),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE item_tags (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  target_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation <> ''),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0),
  CHECK (source_item_id <> target_item_id)
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'snoozed', 'completed', 'cancelled')),
  due_at INTEGER NOT NULL CHECK (due_at >= 0),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE reminder_deliveries (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reminder_id TEXT NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('desktop', 'browser', 'email')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  scheduled_at INTEGER CHECK (scheduled_at IS NULL OR scheduled_at >= 0),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE flashcards (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL CHECK (prompt <> ''),
  answer TEXT NOT NULL CHECK (answer <> ''),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'retired')),
  due_at INTEGER CHECK (due_at IS NULL OR due_at >= 0),
  interval_days INTEGER NOT NULL DEFAULT 0 CHECK (interval_days >= 0),
  ease_factor REAL NOT NULL DEFAULT 2.5 CHECK (ease_factor > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE quiz_results (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  quiz_kind TEXT NOT NULL CHECK (quiz_kind <> ''),
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score > 0 AND score <= max_score),
  answers_json TEXT NOT NULL DEFAULT '{}',
  completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE research_jobs (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  query TEXT NOT NULL CHECK (query <> ''),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  result_json TEXT,
  error_code TEXT,
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  finished_at INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE digests (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (title <> ''),
  body TEXT NOT NULL,
  period_start INTEGER NOT NULL CHECK (period_start >= 0),
  period_end INTEGER NOT NULL CHECK (period_end >= period_start),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE settings (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key <> ''),
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= 0)
);

CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY CHECK (id <> ''),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code TEXT NOT NULL CHECK (code <> ''),
  details_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);

CREATE UNIQUE INDEX uq_bookmarks_live_item ON bookmarks(profile_id, item_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_bookmarks_profile_updated ON bookmarks(profile_id, deleted_at, updated_at DESC, id);
CREATE INDEX idx_connections_profile_endpoints ON connections(profile_id, source_item_id, target_item_id, deleted_at, relation);
CREATE UNIQUE INDEX uq_connections_live_endpoints ON connections(profile_id, source_item_id, target_item_id, relation) WHERE deleted_at IS NULL;
CREATE INDEX idx_connections_profile_target ON connections(profile_id, target_item_id, deleted_at, updated_at DESC);
CREATE INDEX idx_digests_profile_period ON digests(profile_id, deleted_at, period_end DESC, id);
CREATE INDEX idx_flashcards_profile_due ON flashcards(profile_id, state, deleted_at, due_at, id);
CREATE INDEX idx_highlights_profile_item ON highlights(profile_id, item_id, deleted_at, created_at, id);
CREATE UNIQUE INDEX uq_item_tags_live ON item_tags(profile_id, item_id, tag_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_item_tags_profile_tag ON item_tags(profile_id, tag_id, deleted_at, item_id);
CREATE INDEX idx_items_profile_updated ON items(profile_id, deleted_at, updated_at DESC, id);
CREATE INDEX idx_items_profile_kind ON items(profile_id, kind, deleted_at, updated_at DESC, id);
CREATE INDEX idx_notes_profile_item ON notes(profile_id, item_id, deleted_at, updated_at DESC, id);
CREATE INDEX idx_quiz_results_profile_completed ON quiz_results(profile_id, deleted_at, completed_at DESC, id);
CREATE INDEX idx_reminder_deliveries_pending ON reminder_deliveries(profile_id, state, scheduled_at, attempt_count, id);
CREATE INDEX idx_reminders_profile_due ON reminders(profile_id, state, deleted_at, due_at, id);
CREATE INDEX idx_research_jobs_profile_state ON research_jobs(profile_id, state, deleted_at, updated_at, id);
CREATE UNIQUE INDEX uq_settings_live_key ON settings(profile_id, key) WHERE deleted_at IS NULL;
CREATE INDEX idx_tags_profile_name ON tags(profile_id, deleted_at, normalized_name, id);
CREATE UNIQUE INDEX uq_tags_live_name ON tags(profile_id, normalized_name) WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE items_fts USING fts5(
  item_id UNINDEXED,
  profile_id UNINDEXED,
  title,
  excerpt,
  body,
  tokenize = 'unicode61'
);

CREATE TRIGGER items_fts_after_insert AFTER INSERT ON items
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO items_fts(item_id, profile_id, title, excerpt, body)
  VALUES (NEW.id, NEW.profile_id, NEW.title, NEW.excerpt, NEW.body);
END;

CREATE TRIGGER items_fts_before_update BEFORE UPDATE ON items
BEGIN
  DELETE FROM items_fts WHERE item_id = OLD.id;
END;

CREATE TRIGGER items_fts_after_update AFTER UPDATE ON items
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO items_fts(item_id, profile_id, title, excerpt, body)
  VALUES (NEW.id, NEW.profile_id, NEW.title, NEW.excerpt, NEW.body);
END;

CREATE TRIGGER items_fts_before_delete BEFORE DELETE ON items
BEGIN
  DELETE FROM items_fts WHERE item_id = OLD.id;
END;
