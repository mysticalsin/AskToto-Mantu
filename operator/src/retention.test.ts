import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { D1DatabaseLike } from './d1'
import { pruneRetention, RETENTION_MS } from './retention'
import { memoryStore } from './store'

const NOW = 1_725_000_000_000

/** Minimal real-SQLite D1 shim, same shape as `d1.store.test.ts`'s, for the two raw tables
 *  `pruneRetention` prunes outside the `OperatorStore` interface. */
function sqliteD1(db: DatabaseSync): D1DatabaseLike {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) {
          bound = values
          return wrapper
        },
        async first<T>() {
          const row = stmt.get(...(bound as never[]))
          return (row as T) ?? null
        },
        async all<T>() {
          return { results: stmt.all(...(bound as never[])) as T[] }
        },
        async run() {
          return stmt.run(...(bound as never[]))
        }
      }
      return wrapper
    }
  }
}

describe('pruneRetention', () => {
  it('deletes events, audit, asks, and crm_sends older than their retention window, capped per call', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e-old', ts: NOW - RETENTION_MS.events - 1, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.insertEvent({ id: 'e-new', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    await store.audit('a-old', NOW - RETENTION_MS.audit - 1, 'tony', 'reveal', null, 'x')
    await store.audit('a-new', NOW, 'tony', 'reveal', null, 'x')
    await store.insertAsk(askRow({ id: 'ask-old', ts: NOW - RETENTION_MS.asks - 1 }))
    await store.insertAsk(askRow({ id: 'ask-new', ts: NOW }))

    const result = await pruneRetention(store, NOW)

    expect(result.events).toBe(1)
    expect(result.audit).toBe(1)
    expect(result.asks).toBe(1)
    expect((await store.listEvents(10)).map((e) => e.id)).toEqual(['e-new'])
    // pruneRetention itself writes one platform.heartbeat audit row per run (task B6), so the
    // surviving count is the untouched 'a-new' row plus that heartbeat, not just 'a-new' alone.
    const auditRows = await store.listAudit(10)
    expect(auditRows.filter((r) => r.action !== 'platform.heartbeat')).toHaveLength(1)
    expect((await store.listAsks(10)).map((a) => a.id)).toEqual(['ask-new'])
  })

  it('caps deletions per call so one tick never runs away', async () => {
    const store = memoryStore()
    for (let i = 0; i < 10; i++) {
      await store.insertEvent({ id: `e-${i}`, ts: 0, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    }
    const result = await pruneRetention(store, NOW, { events: 3 })
    expect(result.events).toBe(3)
  })

  it('closes stale sessions as part of the same pass', async () => {
    const store = memoryStore()
    await store.touchSession('dev-a', NOW - 10 * 60 * 1000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const result = await pruneRetention(store, NOW)
    expect(result.staleSessionsClosed).toBe(1)
    const sessions = (await store.listSessions({ deviceId: 'dev-a', limit: 10 })).rows
    expect(sessions[0]?.ended_at).not.toBeNull()
  })

  it('does not touch rows inside the retention window', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e-recent', ts: NOW - 1000, kind: 'heartbeat', actor: null, device_id: 'd', country: null, detail: null })
    const result = await pruneRetention(store, NOW)
    expect(result.events).toBe(0)
    expect((await store.listEvents(10)).length).toBe(1)
  })

  it('writes one platform.heartbeat audit row per run, with the counts in its detail', async () => {
    const store = memoryStore()
    const result = await pruneRetention(store, NOW)
    const rows = (await store.listAudit(10, { action: 'platform.heartbeat' }))
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('system')
    expect(rows[0].detail).toContain(`events ${result.events}`)
    expect(rows[0].detail).toContain(`integration_grants ${result.integration_grants}`)
    expect(rows[0].detail).toContain(`mcp_calls ${result.mcp_calls}`)
  })

  it('never throws, and returns 0, for the two raw D1 tables when no D1 is bound', async () => {
    const store = memoryStore()
    const result = await pruneRetention(store, NOW)
    expect(result.integration_grants).toBe(0)
    expect(result.mcp_calls).toBe(0)
  })

  it('prunes integration_grants older than 365 d directly against D1, capped per call', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE integration_grants (id TEXT PRIMARY KEY, integration_id TEXT NOT NULL, device_id TEXT NOT NULL, ts INTEGER NOT NULL)')
    db.exec(`INSERT INTO integration_grants VALUES ('g-old', 'int-1', 'dev-a', ${NOW - RETENTION_MS.integration_grants - 1})`)
    db.exec(`INSERT INTO integration_grants VALUES ('g-new', 'int-1', 'dev-a', ${NOW})`)
    const store = memoryStore()

    const result = await pruneRetention(store, NOW, {}, { db: sqliteD1(db) })

    expect(result.integration_grants).toBe(1)
    const remaining = db.prepare('SELECT id FROM integration_grants').all() as { id: string }[]
    expect(remaining.map((r) => r.id)).toEqual(['g-new'])
  })

  it('guards mcp_calls with a table-exists check so the cron never throws before task B3 creates it', async () => {
    const db = new DatabaseSync(':memory:')
    // No mcp_calls table at all - simulates a D1 that predates the MCP gateway (task B3).
    const store = memoryStore()

    const result = await pruneRetention(store, NOW, {}, { db: sqliteD1(db) })

    expect(result.mcp_calls).toBe(0)
  })

  it('prunes mcp_calls older than 90 d once the table exists', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE mcp_calls (id TEXT PRIMARY KEY, ts INTEGER NOT NULL)')
    db.exec(`INSERT INTO mcp_calls VALUES ('c-old', ${NOW - RETENTION_MS.mcp_calls - 1})`)
    db.exec(`INSERT INTO mcp_calls VALUES ('c-new', ${NOW})`)
    const store = memoryStore()

    const result = await pruneRetention(store, NOW, {}, { db: sqliteD1(db) })

    expect(result.mcp_calls).toBe(1)
    const remaining = db.prepare('SELECT id FROM mcp_calls').all() as { id: string }[]
    expect(remaining.map((r) => r.id)).toEqual(['c-new'])
  })
})

function askRow(partial: { id: string; ts: number }) {
  return {
    device_id: 'dev-a',
    mode: null,
    skill_id: null,
    skill_version: null,
    provider: null,
    model: null,
    ttft_ms: null,
    total_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: null,
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: null,
    question_type: null,
    ...partial
  }
}
