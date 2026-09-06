-- Additive columns/tables for an existing metis-operator D1.
-- Safe to re-run only if the column/table is missing. If a statement fails because
-- the column already exists, continue with the rest.

ALTER TABLE seats ADD COLUMN country TEXT;
ALTER TABLE seats ADD COLUMN city TEXT;
ALTER TABLE seats ADD COLUMN lat REAL;
ALTER TABLE seats ADD COLUMN lon REAL;
ALTER TABLE seats ADD COLUMN last_index_at INTEGER;

CREATE TABLE IF NOT EXISTS pulses (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  country TEXT,
  city TEXT
);

CREATE INDEX IF NOT EXISTS pulses_ts ON pulses(ts);
CREATE INDEX IF NOT EXISTS pulses_kind_ts ON pulses(kind, ts);

CREATE TABLE IF NOT EXISTS crm_sends (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  connector TEXT NOT NULL,
  meeting_file TEXT,
  last_error TEXT,
  retry_requested INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS crm_sends_ts ON crm_sends(ts);
CREATE INDEX IF NOT EXISTS crm_sends_status ON crm_sends(status);

ALTER TABLE crm_sends ADD COLUMN meeting_hash TEXT;
ALTER TABLE crm_sends ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_sends ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crm_sends ADD COLUMN remote_id TEXT;
ALTER TABLE crm_sends ADD COLUMN remote_url TEXT;
ALTER TABLE crm_sends ADD COLUMN action TEXT;

ALTER TABLE seats ADD COLUMN hostname TEXT;
ALTER TABLE seats ADD COLUMN sso_email TEXT;
ALTER TABLE seats ADD COLUMN license TEXT;
ALTER TABLE seats ADD COLUMN approval TEXT;
ALTER TABLE seats ADD COLUMN license_jti TEXT;

CREATE TABLE IF NOT EXISTS issued_licenses (
  jti TEXT PRIMARY KEY,
  last4 TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  days INTEGER NOT NULL,
  iat INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS issued_licenses_exp ON issued_licenses(exp);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  device_id TEXT,
  country TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);

CREATE TABLE IF NOT EXISTS vault_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  last4 TEXT NOT NULL,
  cipher TEXT NOT NULL,
  iv TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
