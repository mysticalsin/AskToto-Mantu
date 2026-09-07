-- Additive columns/tables/indexes for an existing metis-operator D1.
-- Applied by operator/scripts/migrate.mjs, one statement at a time. "duplicate column name" and
-- "already exists" are expected and skipped; any other failure stops the run.

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
  city TEXT,
  region TEXT
);

CREATE INDEX IF NOT EXISTS pulses_ts ON pulses(ts);
CREATE INDEX IF NOT EXISTS pulses_kind_ts ON pulses(kind, ts);

-- Carries every column asks/d1.ts/store.ts expects, so a schema-alter-only run against a very old
-- D1 (schema.sql never applied) still ends up with a usable crm_sends table. The ALTERs below are
-- then no-ops (duplicate column, skipped) on any D1 where this CREATE just ran for real.
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
ALTER TABLE seats ADD COLUMN region TEXT;
ALTER TABLE pulses ADD COLUMN region TEXT;

CREATE INDEX IF NOT EXISTS seats_last_seen ON seats(last_seen);

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
CREATE INDEX IF NOT EXISTS issued_licenses_created ON issued_licenses(created_at);

ALTER TABLE issued_licenses ADD COLUMN group_id TEXT;
ALTER TABLE issued_licenses ADD COLUMN tier TEXT;
ALTER TABLE issued_licenses ADD COLUMN member TEXT;
ALTER TABLE issued_licenses ADD COLUMN activated_device TEXT;
ALTER TABLE issued_licenses ADD COLUMN activated_at INTEGER;
-- Set to 'declined' by the review queue's "let it expire" action (plan 6.7 block 0, task B11,
-- operator/src/licenses/renew.ts). Never changes exp or revoked on its own.
ALTER TABLE issued_licenses ADD COLUMN renewal_note TEXT;

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

ALTER TABLE asks ADD COLUMN question_type TEXT;

ALTER TABLE audit ADD COLUMN request_id TEXT;
ALTER TABLE audit ADD COLUMN route TEXT;

CREATE INDEX IF NOT EXISTS audit_actor_ts ON audit(actor, ts);
CREATE INDEX IF NOT EXISTS proposals_status_created ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS packs_skill_pushed ON packs(skill_id, pushed_at);
CREATE INDEX IF NOT EXISTS nonces_ts ON nonces(ts);

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

CREATE TABLE IF NOT EXISTS integration_grants (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS integration_grants_integration_ts ON integration_grants(integration_id, ts);

-- Connector catalog additive columns (task B2). Kept out of the CREATE TABLE above on purpose: that
-- statement mirrors schema.sql's original integrations table, and these columns are additive-only. Owned
-- by operator/src/connectors/data.ts (INTEGRATION_ALTERS), not d1.ts/store.ts.
ALTER TABLE integrations ADD COLUMN auth_kind TEXT;
ALTER TABLE integrations ADD COLUMN header_name TEXT;
ALTER TABLE integrations ADD COLUMN transport TEXT;
ALTER TABLE integrations ADD COLUMN mode TEXT NOT NULL DEFAULT 'brokered';
ALTER TABLE integrations ADD COLUMN allow_writes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integrations ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE integrations ADD COLUMN tools_json TEXT;
ALTER TABLE integrations ADD COLUMN last_test_json TEXT;
ALTER TABLE integrations ADD COLUMN last_test_at INTEGER;
ALTER TABLE integrations ADD COLUMN notes TEXT;

-- Operator settings key/value store (task B6, plan 3.7b law 3 and 6.11 "Value"): hourly rate,
-- currency, per-seat daily token budget, density, reduced motion. One row per key. A wholly new
-- table (not a redefinition of an existing one, unlike the CREATE TABLEs above it in this file), so
-- it has no counterpart in schema.sql - see migrate.contract.test.ts's "agree on every table name"
-- test for the documented exception. Owned by operator/src/routes/settings-store.ts, never pruned
-- by retention.ts.
CREATE TABLE IF NOT EXISTS operator_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- MCP gateway calls (task B3, plan D8/D10): one row per `tools/call` a seat makes through the gateway.
-- Arguments are never written here, or anywhere - device, connection, tool, latency and outcome only.
-- A wholly new table, same exception as operator_settings above (see migrate.contract.test.ts's "agree
-- on every table name" test and its ALTER_ONLY_NEW_TABLES allowlist). Owned by
-- operator/src/connectors/mcp-calls.ts. Pruned at 90 days by retention.ts (already written to expect
-- exactly this id/ts shape, ahead of this table landing - see that file's module doc).
CREATE TABLE IF NOT EXISTS mcp_calls (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  ms INTEGER NOT NULL,
  outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_calls_connection_ts ON mcp_calls(connection_id, ts);
CREATE INDEX IF NOT EXISTS mcp_calls_device_ts ON mcp_calls(device_id, ts);

-- Shared id stamping every license minted in one POST /v1/admin/licenses/generate-batch call (plan
-- 6.7b, task B-batch, operator/src/licenses/batch.ts). null on every license minted outside a batch.
-- Additive only; no new table, since a batch is otherwise just several issued_licenses rows plus one
-- summary row in the existing audit table (see migrate.contract.test.ts's coverage of this column).
ALTER TABLE issued_licenses ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS issued_licenses_batch_id ON issued_licenses(batch_id);
