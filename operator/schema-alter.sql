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

-- Question-type tracking (closed taxonomy label, never text). Until this lands on a live D1 the Worker
-- stores Asks without a type and logs one warning per isolate; nothing is dropped.
ALTER TABLE asks ADD COLUMN question_type TEXT;
CREATE INDEX IF NOT EXISTS asks_question_type ON asks(question_type);
