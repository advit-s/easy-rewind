CREATE TABLE bookmarks (
  id INTEGER,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  remind_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id INTEGER,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  remind_at TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  reminder_note TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
