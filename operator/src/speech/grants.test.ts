import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { D1DatabaseLike } from '../d1'
import { parseStatements } from '../../scripts/migrate.mjs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allocateSpeechSession, cancelSpeechSession, redeemSpeechGrant } from './grants'

function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      let values: unknown[] = []
      const adapter = {
        bind(...args: unknown[]) { values = args; return adapter },
        async first<T>() { return (stmt.get(...(values as never[])) as T) ?? null },
        async all<T>() { return { results: stmt.all(...(values as never[])) as T[] } },
        async run() { const result = stmt.run(...(values as never[])); return { success: true, meta: { changes: Number(result.changes) } } }
      }
      return adapter
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run() as { success: boolean })
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const root = join(__dirname, '..', '..')
  db.exec(readFileSync(join(root, '..', 'schema.sql'), 'utf8'))
  const alter = readFileSync(join(root, '..', 'schema-alter.sql'), 'utf8')
  for (const sql of parseStatements(alter)) {
    try { db.exec(sql) } catch (error) {
      if (!/duplicate column name|already exists/i.test(String(error))) throw error
    }
  }
  return db
}

const binding = {
  tenantId: 'tenant-a', audience: 'operator-test', licenseJti: 'license-a', deviceId: 'device-a',
  captureGeneration: 7, routeId: 'workers-ai-nova3', model: '@cf/deepgram/nova-3', configVersion: 'v1',
  tracks: ['microphone', 'system'] as const, now: 10_000, licenseExpiresAt: 1_000_000,
  grantTtlMs: 60_000, leaseMs: 300_000, budgetWindowMs: 3_600_000, maxReservedMs: 600_000,
  maxSessions: 1, maxTracks: 2
}

describe('D1 speech grants', () => {
  it('allocates one opaque grant per track and only stores token hashes', async () => {
    const db = migratedDb()
    try {
      const allocation = await allocateSpeechSession(sqliteD1(db), binding)
      expect(allocation.ok).toBe(true)
      if (!allocation.ok) return
      expect(allocation.grants).toHaveLength(2)
      expect(allocation.grants.every((grant) => grant.token.length >= 40)).toBe(true)
      const rows = db.prepare('SELECT token_hash FROM speech_grants').all() as { token_hash: string }[]
      expect(rows.map((row) => row.token_hash)).not.toContain(allocation.grants[0].token)
    } finally { db.close() }
  })

  it('allows only one of two parallel contenders for the final concurrency slot', async () => {
    const db = migratedDb()
    try {
      const results = await Promise.all([
        allocateSpeechSession(sqliteD1(db), binding),
        allocateSpeechSession(sqliteD1(db), { ...binding, deviceId: 'device-b', licenseJti: 'license-b' })
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
    } finally { db.close() }
  })

  it('atomically redeems a token once and binds it to exact session and track', async () => {
    const db = migratedDb()
    try {
      const allocation = await allocateSpeechSession(sqliteD1(db), binding)
      expect(allocation.ok).toBe(true)
      if (!allocation.ok) return
      const grant = allocation.grants[0]
      const context = { ...binding, sessionId: allocation.sessionId, track: grant.track }
      const results = await Promise.all([
        redeemSpeechGrant(sqliteD1(db), grant.token, context),
        redeemSpeechGrant(sqliteD1(db), grant.token, context)
      ])
      expect(results.filter((result) => result.ok)).toHaveLength(1)
      expect(await redeemSpeechGrant(sqliteD1(db), grant.token, { ...context, track: 'system' })).toMatchObject({ ok: false })
    } finally { db.close() }
  })

  it('cancellation releases only its session reservation and is idempotent', async () => {
    const db = migratedDb()
    try {
      const first = await allocateSpeechSession(sqliteD1(db), binding)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = await allocateSpeechSession(sqliteD1(db), { ...binding, deviceId: 'device-b', licenseJti: 'license-b' })
      expect(second).toMatchObject({ ok: false, code: 'CONCURRENCY_LIMIT' })
      expect(await cancelSpeechSession(sqliteD1(db), first.sessionId, binding)).toMatchObject({ ok: true })
      expect(await cancelSpeechSession(sqliteD1(db), first.sessionId, binding)).toMatchObject({ ok: true })
      expect((await allocateSpeechSession(sqliteD1(db), { ...binding, deviceId: 'device-b', licenseJti: 'license-b' })).ok).toBe(true)
    } finally { db.close() }
  })
})
