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

  it('schema-alter.sql only ever ALTERs seats, crm_sends, issued_licenses, and audit (the tables with additive columns)', () => {
    const allowed = new Set(['seats', 'crm_sends', 'issued_licenses', 'audit', 'pulses', 'asks'])
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
    for (const table of fromAlter) {
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
