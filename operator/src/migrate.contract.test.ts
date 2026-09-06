import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPlaceholderDatabaseId, parseStatements, resolveDatabaseName, stripJsonComments } from '../scripts/migrate.mjs'

const OPERATOR_ROOT = join(__dirname, '..')
const schemaSql = readFileSync(join(OPERATOR_ROOT, 'schema.sql'), 'utf8')
const schemaAlterSql = readFileSync(join(OPERATOR_ROOT, 'schema-alter.sql'), 'utf8')
const wranglerJsonc = readFileSync(join(OPERATOR_ROOT, 'wrangler.jsonc'), 'utf8')

describe('migrate.mjs statement parsing and idempotency contract', () => {
  it('parseStatements splits both files into non-empty, comment-free statements', () => {
    for (const sql of [schemaSql, schemaAlterSql]) {
      const statements = parseStatements(sql)
      expect(statements.length).toBeGreaterThan(10)
      for (const stmt of statements) {
        expect(stmt.trim().length).toBeGreaterThan(0)
        expect(stmt).not.toMatch(/^--/m)
      }
    }
  })

  it('every CREATE TABLE in schema.sql and schema-alter.sql is IF NOT EXISTS', () => {
    for (const sql of [schemaSql, schemaAlterSql]) {
      for (const stmt of parseStatements(sql)) {
        if (/^CREATE TABLE\b/i.test(stmt)) {
          expect(stmt).toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
        }
      }
    }
  })

  it('every CREATE INDEX in schema.sql and schema-alter.sql is IF NOT EXISTS', () => {
    for (const sql of [schemaSql, schemaAlterSql]) {
      for (const stmt of parseStatements(sql)) {
        if (/^CREATE (UNIQUE )?INDEX\b/i.test(stmt)) {
          expect(stmt).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i)
        }
      }
    }
  })

  it('schema-alter.sql only ever ALTERs seats, crm_sends, issued_licenses, audit, and integrations (the tables with additive columns)', () => {
    const allowed = new Set(['seats', 'crm_sends', 'issued_licenses', 'audit', 'pulses', 'asks', 'integrations'])
    for (const stmt of parseStatements(schemaAlterSql)) {
      const m = /^ALTER TABLE (\w+)/i.exec(stmt)
      if (m) expect(allowed.has(m[1])).toBe(true)
    }
  })

  it('schema-alter.sql carries every crm_sends column in its CREATE TABLE (not just the original subset)', () => {
    const stmt = parseStatements(schemaAlterSql).find((s) => /^CREATE TABLE IF NOT EXISTS crm_sends/i.test(s))
    expect(stmt).toBeTruthy()
    for (const col of ['meeting_hash', 'attempt', 'latency_ms', 'remote_id', 'remote_url', 'action']) {
      expect(stmt).toContain(col)
    }
  })

  it('schema.sql and schema-alter.sql agree on every table name they both define', () => {
    const tablesOf = (sql) =>
      new Set(
        parseStatements(sql)
          .map((s) => /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(s)?.[1])
          .filter(Boolean)
      )
    const fromSchema = tablesOf(schemaSql)
    const fromAlter = tablesOf(schemaAlterSql)
    // Every other CREATE TABLE in schema-alter.sql redefines a table schema.sql already created (the
    // richer crm_sends/issued_licenses/etc. definitions, kept for a schema-alter-only run against a
    // very old D1). operator_settings (task B6) and mcp_calls (task B3) are the deliberate exceptions:
    // wholly new tables that have never existed anywhere else, introduced directly in schema-alter.sql
    // with nothing to "agree" with in schema.sql.
    const ALTER_ONLY_NEW_TABLES = new Set(['operator_settings', 'mcp_calls'])
    for (const table of fromAlter) {
      if (ALTER_ONLY_NEW_TABLES.has(table)) continue
      expect(fromSchema.has(table)).toBe(true)
    }
  })
})

describe('resolveDatabaseName (pure resolver, section 9d "Environments")', () => {
  it('resolves the top-level d1_databases binding with no env', () => {
    const resolved = resolveDatabaseName(wranglerJsonc, null)
    expect(resolved.databaseName).toBe('metis-operator')
    expect(resolved.databaseId).toBe('8eb5a081-594c-407c-9470-6a5aa28b9f7c')
  })

  it('resolves env.staging.d1_databases when --env staging is given', () => {
    const resolved = resolveDatabaseName(wranglerJsonc, 'staging')
    expect(resolved.databaseName).toBe('metis-operator-staging')
  })

  it('flags the staging placeholder database id so migrate.mjs refuses to run against it', () => {
    const resolved = resolveDatabaseName(wranglerJsonc, 'staging')
    expect(isPlaceholderDatabaseId(resolved.databaseId)).toBe(true)
    expect(isPlaceholderDatabaseId('8eb5a081-594c-407c-9470-6a5aa28b9f7c')).toBe(false)
  })

  it('throws for an env that does not exist in wrangler.jsonc', () => {
    expect(() => resolveDatabaseName(wranglerJsonc, 'nope')).toThrow(/no env/)
  })

  it('stripJsonComments removes // and block comments without touching string content', () => {
    const stripped = stripJsonComments('{\n  // a comment\n  "a": "http://not-a-comment", /* block */ "b": 1\n}')
    const parsed = JSON.parse(stripped)
    expect(parsed).toEqual({ a: 'http://not-a-comment', b: 1 })
  })
})

describe('schema-alter.sql integrations columns (task B2, operator/src/connectors/data.ts)', () => {
  it('adds every connector catalog column the Worker needs on the integrations table', () => {
    const alters = parseStatements(schemaAlterSql).filter((s) => /^ALTER TABLE integrations\b/i.test(s))
    const columns = [
      'auth_kind',
      'header_name',
      'transport',
      'mode',
      'allow_writes',
      'config_json',
      'tools_json',
      'last_test_json',
      'last_test_at',
      'notes'
    ]
    for (const col of columns) {
      expect(alters.some((s) => s.includes(`ADD COLUMN ${col} `) || s.trim().endsWith(`ADD COLUMN ${col}`))).toBe(true)
    }
  })

  it('defaults mode to brokered and allow_writes to 0, matching operator/src/connectors/data.ts', () => {
    const alters = parseStatements(schemaAlterSql).filter((s) => /^ALTER TABLE integrations\b/i.test(s))
    expect(alters.find((s) => s.includes('COLUMN mode'))).toMatch(/DEFAULT 'brokered'/)
    expect(alters.find((s) => s.includes('COLUMN allow_writes'))).toMatch(/DEFAULT 0/)
  })
})

describe('schema-alter.sql operator_settings table (task B6, operator/src/routes/settings-store.ts)', () => {
  it('creates operator_settings with exactly the four columns the settings store needs', () => {
    const stmt = parseStatements(schemaAlterSql).find((s) => /^CREATE TABLE IF NOT EXISTS operator_settings\b/i.test(s))
    expect(stmt).toBeTruthy()
    for (const col of ['key TEXT PRIMARY KEY', 'value_json TEXT NOT NULL', 'updated_at INTEGER NOT NULL', 'updated_by TEXT NOT NULL']) {
      expect(stmt.replace(/\s+/g, ' ')).toContain(col)
    }
  })

  it('is IF NOT EXISTS, same as every other CREATE TABLE in either file (idempotency contract above)', () => {
    const stmt = parseStatements(schemaAlterSql).find((s) => /operator_settings/i.test(s) && /^CREATE TABLE/i.test(s))
    expect(stmt).toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
  })

  it('is never targeted by an ALTER TABLE statement (it has no additive columns, ever)', () => {
    const alters = parseStatements(schemaAlterSql).filter((s) => /^ALTER TABLE operator_settings\b/i.test(s))
    expect(alters).toHaveLength(0)
  })
})

describe('schema-alter.sql mcp_calls table (task B3, operator/src/connectors/mcp-calls.ts)', () => {
  it('creates mcp_calls with exactly the seven columns the gateway audit needs, and never an argument column', () => {
    const stmt = parseStatements(schemaAlterSql).find((s) => /^CREATE TABLE IF NOT EXISTS mcp_calls\b/i.test(s))
    expect(stmt).toBeTruthy()
    for (const col of [
      'id TEXT PRIMARY KEY',
      'ts INTEGER NOT NULL',
      'device_id TEXT NOT NULL',
      'connection_id TEXT NOT NULL',
      'tool TEXT NOT NULL',
      'ms INTEGER NOT NULL',
      'outcome TEXT NOT NULL'
    ]) {
      expect(stmt.replace(/\s+/g, ' ')).toContain(col)
    }
    expect(stmt.toLowerCase()).not.toContain('argument')
  })

  it('is IF NOT EXISTS, same as every other CREATE TABLE in either file (idempotency contract above)', () => {
    const stmt = parseStatements(schemaAlterSql).find((s) => /^CREATE TABLE IF NOT EXISTS mcp_calls\b/i.test(s))
    expect(stmt).toMatch(/^CREATE TABLE IF NOT EXISTS\b/i)
  })

  it('is never targeted by an ALTER TABLE statement (it has no additive columns, ever)', () => {
    const alters = parseStatements(schemaAlterSql).filter((s) => /^ALTER TABLE mcp_calls\b/i.test(s))
    expect(alters).toHaveLength(0)
  })

  it('has an index on (connection_id, ts) and on (device_id, ts) for the admin listing and retention prune', () => {
    for (const stmt of parseStatements(schemaAlterSql)) {
      if (/^CREATE (UNIQUE )?INDEX\b/i.test(stmt) && /mcp_calls/i.test(stmt)) {
        expect(stmt).toMatch(/^CREATE INDEX IF NOT EXISTS\b/i)
      }
    }
    const indexNames = parseStatements(schemaAlterSql)
      .map((s) => /^CREATE INDEX IF NOT EXISTS (\w+) ON mcp_calls/i.exec(s)?.[1])
      .filter(Boolean)
    expect(indexNames).toEqual(expect.arrayContaining(['mcp_calls_connection_ts', 'mcp_calls_device_ts']))
  })
})

describe('schema-alter.sql issued_licenses renewal_note column (task B11, operator/src/licenses/renew.ts)', () => {
  it('adds a nullable renewal_note column, additive only, never NOT NULL', () => {
    const alters = parseStatements(schemaAlterSql).filter((s) => /^ALTER TABLE issued_licenses\b/i.test(s))
    const stmt = alters.find((s) => /ADD COLUMN renewal_note\b/i.test(s))
    expect(stmt).toBeTruthy()
    expect(stmt).not.toMatch(/NOT NULL/i)
  })
})
