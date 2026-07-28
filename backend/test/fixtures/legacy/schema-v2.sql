CREATE TABLE items (
  id INTEGER,
  user_id TEXT NOT NULL,
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  ai_summary TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'web',
  memory_score REAL NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_tags (
  id INTEGER,
  item_id INTEGER NOT NULL,
  tag TEXT NOT NULL
);
