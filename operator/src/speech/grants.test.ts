import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { D1DatabaseLike } from '../d1'
import { parseStatements } from '../../scripts/migrate.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allocateSpeechSession, cancelSpeechSession, redeemSpeechGrant } from './grants'

const batchTails = new WeakMap<DatabaseSync, Promise<void>>()

function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      let values: unknown[] = []
      const adapter = {
        bind(...args: unknown[]) {
          values = args
          return adapter
        },
        async first<T>() {
          return (stmt.get(...(values as never[])) as T) ?? null
        },
        async all<T>() {
          return { results: stmt.all(...(values as never[])) as T[] }
        },
        async run() {
          const result = stmt.run(...(values as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return adapter
    },
    batch(statements) {
      const batchTail = batchTails.get(db) ?? Promise.resolve()
      const result = batchTail.then(async () => {
        db.exec('BEGIN')
        try {
          const results = []
          for (const statement of statements) results.push((await statement.run()) as { success: boolean })
          db.exec('COMMIT')
          return results
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
      batchTails.set(
        db,
        result.then(
          () => undefined,
          () => undefined
        )
      )
      return result
    }
  }
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const operatorRoot = join(__dirname, '..', '..')
  db.exec(readFileSync(join(operatorRoot, 'schema.sql'), 'utf8'))
  const alter = readFileSync(join(operatorRoot, 'schema-alter.sql'), 'utf8')
  for (const sql of parseStatements(alter)) {
    try {
      db.exec(sql)
    } catch (error) {
      if (!/duplicate column name|already exists/i.test(String(error))) throw error
    }
  }
  return db
}

function brokerDb(): DatabaseSync {
  const db = migratedDb()
  db.prepare('INSERT INTO tiers (id, label, entitlements_json, updated_at) VALUES (?, ?, ?, ?)').run(
    'metis',
    'Métis',
    JSON.stringify(['listen', 'operator_keys']),
    1
  )
  for (const [device, jti] of [
    ['device-a', 'license-a'],
    ['device-b', 'license-b']
  ]) {
    db.prepare(`INSERT INTO issued_licenses (jti, last4, key_hash, days, iat, exp, revoked, created_at, created_by, tier, activated_device)
      VALUES (?, 'test', 'hash', 365, 1, 1000, 0, 1, 'test', 'metis', ?)`).run(jti, device)
    db.prepare(`INSERT INTO seats (device_id, seat_hash, os, app_version, first_seen, last_seen, approval, license_jti)
      VALUES (?, 'hash', 'win32', 'test', 1, 1, 'approved', ?)`).run(device, jti)
  }
  return db
}

const binding = {
  tenantId: 'tenant-a',
  audience: 'operator-test',
  licenseJti: 'license-a',
  deviceId: 'device-a',
  captureGeneration: 7,
  routeId: 'workers-ai-nova3',
  model: '@cf/deepgram/nova-3',
  configVersion: 'v1',
  language: 'en',
  tracks: ['microphone', 'system'] as const,
  now: 10_000,
  licenseExpiresAt: 1_000_000,
  grantTtlMs: 60_000,
  leaseMs: 300_000,
  budgetWindowMs: 3_600_000,
  budgetMaxMs: 1_800_000,
  maxReservedMs: 600_000,
  maxSessions: 1,
  maxTracks: 2
}

describe('D1 speech grants', () => {
  it('installs on fresh schema and upgrades existing data without deleting it', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const operatorRoot = join(__dirname, '..', '..')
      const freshStatements = parseStatements(readFileSync(join(operatorRoot, 'schema.sql'), 'utf8'))
      for (const sql of freshStatements.filter((statement) => !/\bspeech_(?:sessions|grants)\b/i.test(statement)))
        db.exec(sql)
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('speech_sessions', 'speech_grants')"
          )
          .all()
      ).toHaveLength(0)
      db.prepare(`INSERT INTO seats (device_id, seat_hash, os, app_version, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?)`).run('existing-device', 'existing-hash', 'win32', '1.9.7', 1, 2)
      const alter = readFileSync(join(operatorRoot, 'schema-alter.sql'), 'utf8')
      for (const sql of parseStatements(alter)) {
        try {
          db.exec(sql)
        } catch (error) {
          if (!/duplicate column name|already exists/i.test(String(error))) throw error
        }
      }
      expect(db.prepare('SELECT seat_hash FROM seats WHERE device_id = ?').get('existing-device')).toMatchObject({
        seat_hash: 'existing-hash'
      })
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('speech_sessions', 'speech_grants') ORDER BY name"
          )
          .all()
      ).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('allocates one opaque grant per track and only stores token hashes', async () => {
    const db = brokerDb()
    try {
      const allocation = await allocateSpeechSession(sqliteD1(db), binding)
      expect(allocation.ok).toBe(true)
      if (!allocation.ok) return
      expect(allocation.grants).toHaveLength(2)
      expect(allocation.grants.every((grant) => grant.token.length >= 40)).toBe(true)
      const rows = db.prepare('SELECT token_hash FROM speech_grants').all() as { token_hash: string }[]
      expect(rows.map((row) => row.token_hash)).not.toContain(allocation.grants[0].token)
    } finally {
      db.close()
    }
  })

  it('allows only one of two parallel contenders for the final concurrency slot', async () => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const results = await Promise.all([
        allocateSpeechSession(d1, binding),
        allocateSpeechSession(d1, { ...binding, deviceId: 'device-b', licenseJti: 'license-b' })
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('allows only one of two parallel contenders for the final budget reservation', async () => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const limited = { ...binding, maxSessions: 2, maxTracks: 4, budgetMaxMs: binding.maxReservedMs }
      const results = await Promise.all([
        allocateSpeechSession(d1, limited),
        allocateSpeechSession(d1, { ...limited, deviceId: 'device-b', licenseJti: 'license-b' })
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(results.filter((result) => !result.ok && result.code === 'BUDGET_LIMIT')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('rejects every mismatched grant binding without consuming the token, then redeems once', async () => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const allocation = await allocateSpeechSession(d1, binding)
      expect(allocation.ok).toBe(true)
      if (!allocation.ok) return
      const grant = allocation.grants[0]
      const context = { ...binding, sessionId: allocation.sessionId, track: grant.track }
      expect(await redeemSpeechGrant(d1, 'x'.repeat(1_000_000), context)).toMatchObject({
        ok: false,
        code: 'GRANT_REJECTED'
      })
      expect(await redeemSpeechGrant(d1, 'invalid-token', context)).toMatchObject({ ok: false, code: 'GRANT_REJECTED' })
      const mismatches: Array<Partial<typeof context>> = [
        { tenantId: 'tenant-b' },
        { audience: 'operator-other' },
        { licenseJti: 'license-b' },
        { deviceId: 'device-b' },
        { sessionId: crypto.randomUUID() },
        { track: 'system' },
        { captureGeneration: binding.captureGeneration + 1 },
        { routeId: 'deepgram-via-gateway' },
        { model: 'nova-3' },
        { configVersion: 'v2' },
        { language: 'fr' }
      ]
      for (const mismatch of mismatches) {
        expect(await redeemSpeechGrant(d1, grant.token, { ...context, ...mismatch })).toMatchObject({
          ok: false,
          code: 'GRANT_REJECTED'
        })
      }
      const results = await Promise.all([
        redeemSpeechGrant(d1, grant.token, context),
        redeemSpeechGrant(d1, grant.token, context)
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it.each([
    ['revoked license', "UPDATE issued_licenses SET revoked = 1 WHERE jti = 'license-a'"],
    ['normalized revoked seat', "UPDATE seats SET approval = ' ReVoKeD ' WHERE device_id = 'device-a'"],
    ['rebound license', "UPDATE issued_licenses SET activated_device = 'device-b' WHERE jti = 'license-a'"],
    ['missing entitlement', "UPDATE tiers SET entitlements_json = '[\"listen\"]' WHERE id = 'metis'"],
    [
      'non-string entitlement',
      'UPDATE tiers SET entitlements_json = \'["listen","operator_keys",{}]\' WHERE id = \'metis\''
    ],
    ['corrupt entitlements', "UPDATE tiers SET entitlements_json = '{broken' WHERE id = 'metis'"]
  ])('refuses grant redemption after current authorization fails: %s', async (_name, mutation) => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const allocation = await allocateSpeechSession(d1, binding)
      expect(allocation.ok).toBe(true)
      if (!allocation.ok) return
      db.exec(mutation)
      expect(
        await redeemSpeechGrant(d1, allocation.grants[0].token, {
          ...binding,
          sessionId: allocation.sessionId,
          track: allocation.grants[0].track
        })
      ).toMatchObject({ ok: false, code: 'GRANT_REJECTED' })
    } finally {
      db.close()
    }
  })

  it.each([
    ['missing batch results', []],
    ['failed batch result', [{ success: false }]]
  ])('fails closed on %s before a session is committed', async (_name, batchResult) => {
    const db = brokerDb()
    try {
      const base = sqliteD1(db)
      const unavailable: D1DatabaseLike = {
        ...base,
        async batch() {
          return batchResult
        }
      }
      expect(await allocateSpeechSession(unavailable, binding)).toMatchObject({
        ok: false,
        code: 'DATABASE_UNAVAILABLE'
      })
      expect(db.prepare('SELECT COUNT(*) AS n FROM speech_sessions').get()).toMatchObject({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('cancellation releases only its session reservation and is idempotent', async () => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const sharedCapacity = { ...binding, maxSessions: 2, maxTracks: 4 }
      const first = await allocateSpeechSession(d1, sharedCapacity)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = await allocateSpeechSession(d1, {
        ...sharedCapacity,
        deviceId: 'device-b',
        licenseJti: 'license-b'
      })
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(await cancelSpeechSession(d1, first.sessionId, binding)).toMatchObject({ ok: true })
      expect(await cancelSpeechSession(d1, first.sessionId, binding)).toMatchObject({ ok: true })
      expect(
        db.prepare('SELECT status, reserved_ms FROM speech_sessions WHERE id = ?').get(second.sessionId)
      ).toMatchObject({ status: 'active', reserved_ms: binding.maxReservedMs })
      expect((await allocateSpeechSession(d1, sharedCapacity)).ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('expiry releases only an unredeemed reservation in its tenant and audience', async () => {
    const db = brokerDb()
    try {
      const d1 = sqliteD1(db)
      const first = await allocateSpeechSession(d1, binding)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const expired = await allocateSpeechSession(d1, {
        ...binding,
        deviceId: 'device-b',
        licenseJti: 'license-b',
        now: binding.now + binding.leaseMs + 1,
        licenseExpiresAt: binding.licenseExpiresAt
      })
      expect(expired.ok).toBe(true)
      const rows = db
        .prepare('SELECT id, status, reserved_ms FROM speech_sessions ORDER BY created_at')
        .all() as Array<{ id: string; status: string; reserved_ms: number }>
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ id: first.sessionId, status: 'expired', reserved_ms: 0 })
      expect(rows[1]).toMatchObject({ status: 'active' })
    } finally {
      db.close()
    }
  })
})
