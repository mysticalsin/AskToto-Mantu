-- metis-operator D1 schema. Apply with: node operator/scripts/migrate.mjs --remote (or --local)
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
  region TEXT,
  lat REAL,
  lon REAL,
  last_index_at INTEGER,
  hostname TEXT,
  sso_email TEXT,
  license TEXT,
  approval TEXT,
  license_jti TEXT
);

CREATE INDEX IF NOT EXISTS seats_last_seen ON seats(last_seen);

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
  preview TEXT,
  question_type TEXT
);

CREATE INDEX IF NOT EXISTS asks_ts ON asks(ts);
CREATE INDEX IF NOT EXISTS asks_mode ON asks(mode);

CREATE TABLE IF NOT EXISTS pulses (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  country TEXT,
  city TEXT,
  region TEXT
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
CREATE INDEX IF NOT EXISTS events_device_ts ON events(device_id, ts);

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

CREATE INDEX IF NOT EXISTS vault_keys_provider_status ON vault_keys(provider, status);

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
CREATE INDEX IF NOT EXISTS crm_sends_device_retry ON crm_sends(device_id, retry_requested);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nonces_ts ON nonces(ts);

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

CREATE INDEX IF NOT EXISTS proposals_status_created ON proposals(status, created_at);

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

CREATE INDEX IF NOT EXISTS packs_skill_pushed ON packs(skill_id, pushed_at);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  ask_id TEXT,
  detail TEXT,
  request_id TEXT,
  route TEXT
);

CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE INDEX IF NOT EXISTS audit_actor_ts ON audit(actor, ts);

CREATE TABLE IF NOT EXISTS issued_licenses (
  jti TEXT PRIMARY KEY,
  last4 TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  days INTEGER NOT NULL,
  iat INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  group_id TEXT,
  tier TEXT,
  member TEXT,
  activated_device TEXT,
  activated_at INTEGER
);

CREATE INDEX IF NOT EXISTS issued_licenses_exp ON issued_licenses(exp);
CREATE INDEX IF NOT EXISTS issued_licenses_created ON issued_licenses(created_at);

-- A session is one seat's pulses (heartbeat, ask, recap) with gaps under 2 minutes. The ingest
-- path materializes these via OperatorStore#touchSession (operator/src/sessions.ts owns the pure
-- 2-minute-gap math); a daily cron plus closeStaleSessions() closes sessions that stopped pulsing.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_pulse_at INTEGER NOT NULL,
  ended_at INTEGER,
  pulses INTEGER NOT NULL DEFAULT 0,
  asks INTEGER NOT NULL DEFAULT 0,
  recaps INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  city TEXT,
  os TEXT,
  app_version TEXT
);

CREATE INDEX IF NOT EXISTS sessions_device_started ON sessions(device_id, started_at);
CREATE INDEX IF NOT EXISTS sessions_last_pulse ON sessions(last_pulse_at);

-- Groups and tiers (section 9c). A seat resolves to a group through its active issued license
-- (group_id/tier on issued_licenses), or a member email/device match in group_members.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  member TEXT NOT NULL,
  kind TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (group_id, member)
);

CREATE INDEX IF NOT EXISTS group_members_member ON group_members(member);

CREATE TABLE IF NOT EXISTS tiers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  entitlements_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One credential per CRM or MCP connection, scoped to tiers/groups. cipher/iv null once revoked.
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT,
  cipher TEXT,
  iv TEXT,
  last4 TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  rotated_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);

-- Audit of every credential delivery to a seat (GET /v1/integrations).
CREATE TABLE IF NOT EXISTS integration_grants (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS integration_grants_integration_ts ON integration_grants(integration_id, ts);
