import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { sha256Hex } from './crypto'
import { d1Store, type D1DatabaseLike } from './d1'
import { hmacHex } from './hmac'
import { handleRequest, type Env } from './index'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const DEVICE = 'pulse-retry-device'
const ASK_ID = 'pulse-retry-ask'
const ENV: Env = { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY }

function sqliteD1WithOneFailedSessionWrite(db: DatabaseSync, failOnSessionWrite = 1): D1DatabaseLike {
  let sessionWrites = 0
  let queued = Promise.resolve()
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) { bound = values; return wrapper },
        async first<T>() { return (stmt.get(...(bound as never[])) as T) ?? null },
        async all<T>() { return { results: stmt.all(...(bound as never[])) as T[] } },
        async run() {
          if (sql.includes('INTO sessions') && ++sessionWrites === failOnSessionWrite) {
            throw new Error('transient session write failure')
          }
          const result = stmt.run(...(bound as never[]))
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
    },
    async batch(statements) {
      const transaction = queued.then(async () => {
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
      })
      queued = transaction.then(() => {}, () => {})
      return transaction
    }
  }
}

async function ingest(store: ReturnType<typeof d1Store>): Promise<Response> {
  const body = JSON.stringify({ id: ASK_ID, ts: NOW, mode: 'recap', provider: 'cloudflare' })
  const ts = String(NOW)
  const nonce = randomUUID()
  const hash = await sha256Hex(body)
  const sig = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, DEVICE, hash))
  const request = new Request('https://operator.test/v1/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: DEVICE,
      [OPERATOR_HMAC_HEADERS.sig]: sig
    },
    body
  })
  return handleRequest(request, ENV, {}, { store, now: NOW })
}

it('MQA-345 retries a failed Ask session write without leaving a pulse uncounted or counting it twice', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
    const store = d1Store(sqliteD1WithOneFailedSessionWrite(db))

    await expect(ingest(store)).rejects.toThrow('transient session write failure')
    expect((await store.listPulses(NOW - 1)).filter((row) => row.id === `ask:${ASK_ID}`)).toHaveLength(0)

    expect((await ingest(store)).status).toBe(200)
    expect((await ingest(store)).status).toBe(200)
    expect((await store.listPulses(NOW - 1)).filter((row) => row.id === `ask:${ASK_ID}`)).toHaveLength(1)
    const sessions = await store.listSessions({ deviceId: DEVICE, limit: 10 })
    expect(sessions.rows).toHaveLength(1)
    expect(sessions.rows[0]).toMatchObject({ pulses: 1, asks: 1 })
  } finally {
    db.close()
  }
})

it('counts two simultaneous Ask pulses for one device in a single session', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
    const store = d1Store(sqliteD1WithOneFailedSessionWrite(db, 0))
    const seatMeta = { os: 'darwin', app_version: '2.0.0' }
    await Promise.all(['concurrent-a', 'concurrent-b'].map((id) => store.recordPulseSession({
      id, device_id: DEVICE, ts: NOW, kind: 'ask', country: 'CA', city: 'Montréal', region: 'QC'
    }, seatMeta)))

    const sessions = await store.listSessions({ deviceId: DEVICE, limit: 10 })
    expect(sessions.rows).toHaveLength(1)
    expect(sessions.rows[0]).toMatchObject({ pulses: 2, asks: 2 })
  } finally {
    db.close()
  }
})

it('rolls back a failed new session after a gap, then closes the old session on retry', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
    const store = d1Store(sqliteD1WithOneFailedSessionWrite(db, 2))
    const seatMeta = { os: 'darwin', app_version: '2.0.0' }
    const first = { id: 'first-heartbeat', device_id: DEVICE, ts: NOW, kind: 'heartbeat' as const,
      country: 'CA', city: 'Montréal', region: 'QC' }
    const second = { ...first, id: 'second-heartbeat', ts: NOW + 3 * 60_000 }

    expect(await store.recordPulseSession(first, seatMeta)).toBe(true)
    await expect(store.recordPulseSession(second, seatMeta)).rejects.toThrow('transient session write failure')
    expect(await store.listPulses(NOW - 1)).toHaveLength(1)
    expect((await store.listSessions({ deviceId: DEVICE, limit: 10 })).rows).toMatchObject([
      { id: expect.any(String), ended_at: null, pulses: 1 }
    ])

    expect(await store.recordPulseSession(second, seatMeta)).toBe(true)
    const sessions = (await store.listSessions({ deviceId: DEVICE, limit: 10 })).rows
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ started_at: second.ts, ended_at: null, pulses: 1 })
    expect(sessions[1]).toMatchObject({ started_at: first.ts, ended_at: first.ts, pulses: 1 })
  } finally {
    db.close()
  }
})
