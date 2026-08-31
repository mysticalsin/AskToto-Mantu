-- metis-operator D1 schema. Apply with: npx wrangler d1 execute metis-operator --file=schema.sql
-- Prompt bodies are ciphertext only. Never store plaintext Ask text.
-- Geo is country ISO + optional city + optional lat/lon from Cloudflare request.cf only. Never store IP.

CREATE TABLE IF NOT EXISTS seats (
  device_id TEXT PRIMARY KEY,
  seat_hash TEXT NOT NULL,
  os TEXT NOT NULL,
  app_version TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  country TEXT,
  city TEXT,
  lat REAL,
  lon REAL,
  last_index_at INTEGER
);

CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  mode TEXT,
  skill_id TEXT,
  skill_version TEXT,
  provider TEXT,
  model TEXT,
  ttft_ms INTEGER,
  total_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  cache_uncached INTEGER,
  cache_status TEXT,
  cache_ttl TEXT,
  outcome TEXT,
  rating TEXT,
  prompt_cipher TEXT,
  prompt_iv TEXT,
  preview TEXT
);

CREATE INDEX IF NOT EXISTS asks_ts ON asks(ts);
CREATE INDEX IF NOT EXISTS asks_mode ON asks(mode);

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

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  device_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  from_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  diff TEXT NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS packs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  body TEXT NOT NULL,
  signed TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  pushed_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ask_id TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
