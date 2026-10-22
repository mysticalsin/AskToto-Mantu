import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseStatements } from '../../scripts/migrate.mjs'
import { d1Store } from '../d1'
import { sha256Hex } from '../crypto'
import { generateOperatorLicense } from '../../../src/shared/operator-license'
import { handleRequest } from '../index'
import { d1SchemaStatus, EXPECTED_D1_TABLES } from '../routes/admin-core'
import { migratedDb, sqliteD1 } from '../test-d1'
import { TEST_INGEST_SECRET } from '../test-fixtures'
import { baseEnv, DEVICE, heartbeat, NOW, ownerAccess } from './enroll-test-kit'

const OPERATOR_ROOT = join(__dirname, '..', '..')
const alterSql = readFileSync(join(OPERATOR_ROOT, 'schema-alter.sql'), 'utf8')
const schemaSql = readFileSync(join(OPERATOR_ROOT, 'schema.sql'), 'utf8')

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

function applyAlter(db: DatabaseSync): void {
  for (const stmt of parseStatements(alterSql)) {
    try {
      db.exec(stmt)
    } catch (error) {
      if (!/duplicate column name|already exists/i.test(String(error))) throw error
    }
  }
}

/** The shape of an existing production D1 before the enrolment migration: no enrolment tables or columns. */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE seats (device_id TEXT PRIMARY KEY, seat_hash TEXT NOT NULL, os TEXT NOT NULL, app_version TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, country TEXT, city TEXT, region TEXT, lat REAL, lon REAL,
      last_index_at INTEGER, hostname TEXT, sso_email TEXT, license TEXT, approval TEXT, license_jti TEXT);
    CREATE TABLE issued_licenses (jti TEXT PRIMARY KEY, last4 TEXT NOT NULL, key_hash TEXT NOT NULL, days INTEGER NOT NULL,
      iat INTEGER NOT NULL, exp INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, created_by TEXT,
      group_id TEXT, tier TEXT, member TEXT, activated_device TEXT, activated_at INTEGER);
    INSERT INTO seats VALUES ('legacy-device-1', 'h', 'darwin', '2.11.0', 1, 2, NULL, NULL, NULL, NULL, NULL, NULL, 'host', NULL, 'approved', 'approved', NULL);
    INSERT INTO issued_licenses VALUES ('1111111111111111', 'abcd', 'hash', 30, 1, 99999999999, 0, 1, 'admin', NULL, 'metis', NULL, NULL, NULL);
  `)
  // The rest of the pre-enrolment schema, exactly as it was applied before O02.
  for (const stmt of parseStatements(schemaSql).filter((statement) => !/enroll/i.test(statement))) db.exec(stmt)
  return db
}

describe('enrolment migration (O02)', () => {
  it('the console dashboard still loads on a D1 one migration behind, with an empty token list', async () => {
    const db = migratedDb()
    db.exec('DROP TABLE enrollments; DROP TABLE enroll_tokens;')
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/dashboard'),
      baseEnv(),
      {},
      { store: d1Store(sqliteD1(db)), now: NOW, access: ownerAccess() }
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { enrollment: { tokens: unknown[] } }).enrollment.tokens).toEqual([])
  })

  it('adds the enrolment tables, indexes and columns to a legacy D1 without touching existing rows', () => {
    const db = legacyDb()
    expect(columns(db, 'seats')).not.toContain('enroll_method')
    applyAlter(db)
    expect(columns(db, 'seats')).toEqual(expect.arrayContaining(['enroll_method', 'sso_verified_email']))
    expect(columns(db, 'issued_licenses')).toEqual(expect.arrayContaining(['origin', 'supersedes']))
    expect(columns(db, 'enroll_tokens')).toEqual([
      'kid',
      'secret_hash',
      'label',
      'channel',
      'tier',
      'license_days',
      'max_devices',
      'daily_cap',
      'enrolled_count',
      'created_at',
      'created_by',
      'expires_at',
      'revoked_at',
      'revoked_by',
      'revoke_reason'
    ])
    expect(columns(db, 'enrollments')).toEqual([
      'id',
      'device_id',
      'method',
      'token_kid',
      'sso_oid_hash',
      'sso_email',
      'license_jti',
      'supersedes',
      'created_at',
      'app_version',
      'os'
    ])
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexes).toEqual(expect.arrayContaining(['enrollments_device', 'enrollments_token', 'enrollments_oid']))
    expect(
      db.prepare("SELECT origin, supersedes, tier FROM issued_licenses WHERE jti = '1111111111111111'").get()
    ).toEqual({
      origin: null,
      supersedes: null,
      tier: 'metis'
    })
    expect(db.prepare('SELECT enroll_method, sso_verified_email, approval FROM seats').get()).toEqual({
      enroll_method: null,
      sso_verified_email: null,
      approval: 'approved'
    })
  })

  it('is idempotent: applying schema.sql and schema-alter.sql again changes nothing and throws nothing', () => {
    const db = migratedDb()
    db.exec(schemaSql)
    applyAlter(db)
    applyAlter(db)
    expect(columns(db, 'enrollments')).toHaveLength(11)
  })

  it('schema.sql alone defines both enrolment tables (a fresh database needs no alter step for them)', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(schemaSql)
    expect(columns(db, 'enroll_tokens')).toContain('secret_hash')
    expect(columns(db, 'enrollments')).toContain('sso_oid_hash')
  })

  it('never stores an IP or a raw secret: no such column exists', () => {
    const db = migratedDb()
    for (const table of ['enroll_tokens', 'enrollments']) {
      expect(columns(db, table).filter((c) => /^(ip|secret|token|license|license_key|oid)$/i.test(c))).toEqual([])
    }
  })

  it('/health schema check lists the enrolment tables and columns as missing on a D1 one migration behind', async () => {
    expect(EXPECTED_D1_TABLES).toEqual(expect.arrayContaining(['enroll_tokens', 'enrollments']))
    const fresh = migratedDb()
    expect(await d1SchemaStatus(sqliteD1(fresh))).toMatchObject({ ok: true, missing: [] })
    const behind = migratedDb()
    behind.exec(
      'DROP TABLE enrollments; DROP TABLE enroll_tokens; ALTER TABLE issued_licenses DROP COLUMN origin; ALTER TABLE seats DROP COLUMN enroll_method;'
    )
    const status = await d1SchemaStatus(sqliteD1(behind))
    expect(status.ok).toBe(false)
    expect(status.missing).toEqual(
      expect.arrayContaining(['enroll_tokens', 'enrollments', 'issued_licenses.origin', 'seats.enroll_method'])
    )
    const health = await handleRequest(
      new Request('https://operator.test/health'),
      { ...baseEnv(), DB: sqliteD1(behind) },
      {}
    )
    expect(health.status).toBe(503)
    expect(((await health.json()) as { schema: string[] }).schema).toEqual(expect.arrayContaining(['enrollments']))
  })

  it('a D1 one migration behind still serves admin-licence heartbeats and licence generation (no new column is required)', async () => {
    const db = migratedDb()
    db.exec(
      'DROP TABLE enrollments; DROP TABLE enroll_tokens; ALTER TABLE issued_licenses DROP COLUMN origin; ALTER TABLE issued_licenses DROP COLUMN supersedes; ALTER TABLE seats DROP COLUMN enroll_method; ALTER TABLE seats DROP COLUMN sso_verified_email;'
    )
    const store = d1Store(sqliteD1(db))
    const minted = await generateOperatorLicense(TEST_INGEST_SECRET, { days: 30, now: NOW, jti: '2222222222222222' })
    await store.putIssuedLicense({
      ...minted.claims,
      key_hash: await sha256Hex(minted.token),
      last4: minted.last4,
      days: 30,
      revoked: 0,
      created_at: NOW,
      created_by: 'owner@example.test',
      tier: 'metis'
    })
    const res = await heartbeat(store, minted.token, DEVICE)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, approved: true, tier: 'metis' })
    expect((await store.getSeat(DEVICE))?.license_jti).toBe('2222222222222222')
  })
})
