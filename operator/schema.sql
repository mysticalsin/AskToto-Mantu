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
  last_index_at INTEGER,
  hostname TEXT,
  sso_email TEXT,
  license TEXT,
  product TEXT,
  saved_minutes REAL NOT NULL DEFAULT 0,
  meetings_summarized REAL NOT NULL DEFAULT 0,
  conversation_minutes REAL NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS crm_sends (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  connector TEXT NOT NULL,
  meeting_file TEXT,
  meeting_hash TEXT,
  last_error TEXT,
  retry_requested INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT,
  remote_url TEXT,
  action TEXT
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

CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  seat_cap INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS license_activations (
  license_key TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT NOT NULL DEFAULT '',
  activated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, machine_id)
);

CREATE INDEX IF NOT EXISTS license_activations_key ON license_activations(license_key);
