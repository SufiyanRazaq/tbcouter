PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clan_name TEXT NOT NULL DEFAULT 'My Clan',
  clan_tag TEXT NOT NULL DEFAULT 'CLAN',
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  weekly_target INTEGER NOT NULL DEFAULT 5000,
  share_token TEXT,
  password_hash TEXT,
  password_salt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO settings(id) VALUES(1);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  role TEXT NOT NULL DEFAULT 'Member',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL CHECK(points >= 0),
  aliases TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  UNIQUE(name, level)
);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  last_badge INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  lease_until INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id),
  player_name TEXT NOT NULL,
  catalog_id TEXT REFERENCES catalog(id),
  chest_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0 CHECK(points >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('confirmed','review','void')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','capture','import')),
  confidence REAL,
  raw_text TEXT NOT NULL DEFAULT '',
  evidence TEXT,
  review_reason TEXT NOT NULL DEFAULT '',
  capture_session_id TEXT REFERENCES capture_sessions(id),
  capture_seq INTEGER,
  badge_before INTEGER,
  badge_after INTEGER,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(capture_session_id, capture_seq)
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_player_date ON entries(player_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_entries_status_date ON entries(status, occurred_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at DESC);
