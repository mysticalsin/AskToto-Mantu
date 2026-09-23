import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ingestCanonical, OPERATOR_HMAC_HEADERS } from '../../src/shared/operator-hmac'
import { persistProxyAsk } from './ask-meter'
import { sha256Hex } from './crypto'
import { d1Store, resetD1SchemaProbeForTests, type D1DatabaseLike } from './d1'
import { hmacHex } from './hmac'
import { handleRequest, type Env } from './index'
import { memoryStore, type OperatorStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from './test-fixtures'

// MQA-334: concurrent Ask ownership; MQA-335: activity namespaces; MQA-336: colon-safe cursors.

const NOW = 1_725_000_000_000
const DEVICE = 'device-integrity-a'
const ASK_ID = 'ask-integrity-001'
const ENV: Env = { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY }

function sqliteD1(db: DatabaseSync, omitPulseChanges = false): D1DatabaseLike {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql)
      let bound: unknown[] = []
      const wrapper = {
        bind(...values: unknown[]) { bound = values; return wrapper },
        async first<T>() { return (stmt.get(...(bound as never[])) as T) ?? null },
        async all<T>() { return { results: stmt.all(...(bound as never[])) as T[] } },
        async run() {
          const result = stmt.run(...(bound as never[]))
          if (omitPulseChanges && sql.startsWith('INSERT INTO pulses ')) return { success: true }
          return { success: true, meta: { changes: Number(result.changes) } }
        }
      }
      return wrapper
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

it('does not count a D1 pulse when write metadata cannot prove it was new', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
    const store = d1Store(sqliteD1(db, true))
    expect(await store.insertPulse({
      id: 'unconfirmed-pulse', device_id: DEVICE, ts: NOW, kind: 'ask',
      country: null, city: null, region: null
    })).toBe(false)
  } finally { db.close() }
})

function testStore(kind: 'memory' | 'd1'): { store: OperatorStore; close: () => void } {
  resetD1SchemaProbeForTests()
  if (kind === 'memory') return { store: memoryStore(), close: () => {} }
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8'))
  return { store: d1Store(sqliteD1(db)), close: () => db.close() }
}

async function signedIngest(store: OperatorStore, payload: Record<string, unknown>, deviceId = DEVICE): Promise<Response> {
  const body = JSON.stringify(payload)
  const ts = String(NOW)
  const nonce = randomUUID()
  const digest = await sha256Hex(body)
  const signature = await hmacHex(TEST_INGEST_SECRET, ingestCanonical(ts, nonce, deviceId, digest))
  const request = new Request('https://operator.test/v1/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [OPERATOR_HMAC_HEADERS.ts]: ts,
      [OPERATOR_HMAC_HEADERS.nonce]: nonce,
      [OPERATOR_HMAC_HEADERS.device]: deviceId,
      [OPERATOR_HMAC_HEADERS.sig]: signature
    },
    body
  })
  return handleRequest(request, ENV, {}, { store, now: NOW })
}

async function ingest(store: OperatorStore, id = ASK_ID, deviceId = DEVICE): Promise<Response> {
  return signedIngest(store, {
    id, ts: NOW + 1000, mode: 'recap', provider: 'cloudflare', model: 'worker-model',
    totalMs: 330, questionType: 'factual', pathTag: 'portal-cf', outcome: 'answered'
  }, deviceId)
}

async function meter(store: OperatorStore, id = ASK_ID): Promise<void> {
  await persistProxyAsk(store, {
    askId: id, deviceId: DEVICE, now: NOW, provider: 'cloudflare', model: 'worker-model',
    inputTokens: 42, outputTokens: 17, outcome: 'answered'
  })
}

async function failedLegacyMeter(store: OperatorStore, id = ASK_ID): Promise<void> {
  await persistProxyAsk(store, {
    askId: id, deviceId: DEVICE, now: NOW + 2_000, provider: 'anthropic', model: 'losing-model',
    inputTokens: 7, outputTokens: 3, outcome: 'error'
  })
}

for (const kind of ['memory', 'd1'] as const) {
  describe(`${kind} Ask integrity`, () => {
    for (const order of ['meter-first', 'ingest-first'] as const) {
      it(`combines Worker usage and desktop mode regardless of ${order} write order`, async () => {
        const { store, close } = testStore(kind)
        try {
          if (order === 'meter-first') await meter(store)
          expect((await ingest(store)).status).toBe(200)
          if (order === 'ingest-first') await meter(store)

          expect(await store.getAsk(ASK_ID)).toMatchObject({
            id: ASK_ID, device_id: DEVICE, mode: 'recap', question_type: 'factual',
            total_ms: 330, input_tokens: 42, output_tokens: 17, path_tag: 'portal-cf'
          })
          expect(await store.listAsks(10)).toHaveLength(1)
        } finally { close() }
      })
    }

    it('keeps a user rating after a late Worker meter write', async () => {
      const { store, close } = testStore(kind)
      try {
        expect((await ingest(store)).status).toBe(200)
        await store.updateAskRating(ASK_ID, 'down')
        await meter(store)
        expect(await store.getAsk(ASK_ID)).toMatchObject({ rating: 'down', outcome: 'thumbs-down', mode: 'recap' })
      } finally { close() }
    })

    for (const order of ['failed-meter-first', 'successful-failover-first'] as const) {
      it(`MQA-346 keeps the delivered failover result isolated from a ${order} legacy same-id failure`, async () => {
        const { store, close } = testStore(kind)
        try {
          if (order === 'failed-meter-first') await failedLegacyMeter(store)
          expect((await ingest(store)).status).toBe(200)
          if (order === 'successful-failover-first') await failedLegacyMeter(store)

          expect(await store.getAsk(ASK_ID)).toMatchObject({
            id: ASK_ID,
            device_id: DEVICE,
            mode: 'recap',
            provider: 'cloudflare',
            model: 'worker-model',
            outcome: 'answered',
            input_tokens: null,
            output_tokens: null,
            path_tag: 'portal-cf'
          })
          expect(await store.listAsks(10)).toHaveLength(1)
        } finally { close() }
      })
    }

    it('records one activity pulse and event across same-device ingest retries', async () => {
      const { store, close } = testStore(kind)
      try {
        expect((await ingest(store)).status).toBe(200)
        expect((await ingest(store)).status).toBe(200)
        expect((await store.listPulses(NOW - 1)).filter((p) => p.kind === 'ask')).toHaveLength(1)
        expect((await store.listEvents(10)).filter((e) => e.kind === 'ask')).toHaveLength(1)
        const sessions = await store.listSessions({ limit: 10 })
        expect(sessions.rows[0]?.asks).toBe(1)
      } finally { close() }
    })

    it('pages past a colon-namespaced Ask event without repeating the first page', async () => {
      const { store, close } = testStore(kind)
      try {
        expect((await ingest(store, 'zz')).status).toBe(200)
        expect((await ingest(store, 'aa')).status).toBe(200)
        const first = await store.listEvents(1, { kinds: ['ask'], limit: 1 })
        expect(first.rows.map((event) => event.id)).toEqual(['ask:zz'])
        expect(first.nextCursor).toBeTruthy()
        const second = await store.listEvents(1, { kinds: ['ask'], limit: 1, cursor: first.nextCursor! })
        expect(second.rows.map((event) => event.id)).toEqual(['ask:aa'])
      } finally { close() }
    })

    it('never lets a losing device replace the winning Ask activity after a stale ownership read', async () => {
      const { store, close } = testStore(kind)
      try {
        let arrivals = 0
        let release!: () => void
        const barrier = new Promise<void>((resolve) => { release = resolve })
        const racingStore: OperatorStore = {
          ...store,
          async getAsk(id) {
            if (id === ASK_ID && arrivals < 2) {
              arrivals++
              if (arrivals === 2) release()
              await barrier
              return null
            }
            return store.getAsk(id)
          }
        }
        const responses = await Promise.all([
          ingest(racingStore, ASK_ID, DEVICE),
          ingest(racingStore, ASK_ID, 'device-integrity-b')
        ])
        expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
        const owner = (await store.getAsk(ASK_ID))?.device_id
        expect([DEVICE, 'device-integrity-b']).toContain(owner)
        expect((await store.listEvents(10)).find((event) => event.id === `ask:${ASK_ID}`)?.device_id).toBe(owner)
        expect((await store.listPulses(NOW - 1)).find((pulse) => pulse.id === `ask:${ASK_ID}`)?.device_id).toBe(owner)
        expect((await store.listSessions({ limit: 10 })).rows.reduce((total, session) => total + session.asks, 0)).toBe(1)
      } finally { close() }
    })

    it('keeps Ask, listen, and recap activity separate when a client reuses an Ask event id', async () => {
      const { store, close } = testStore(kind)
      try {
        expect((await ingest(store)).status).toBe(200)
        for (const event of ['listen', 'recap'] as const) {
          expect((await signedIngest(store, { event, id: `ask:${ASK_ID}`, minutes: 1 })).status).toBe(200)
        }
        const events = await store.listEvents(10)
        expect(events).toHaveLength(3)
        expect(events.map((event) => event.kind).sort()).toEqual(['ask', 'listen', 'recap'])
        expect(events.find((event) => event.kind === 'ask')?.id).toBe(`ask:${ASK_ID}`)
      } finally { close() }
    })

    it('allows a second device to log listening with the same raw id as an owned Ask', async () => {
      const { store, close } = testStore(kind)
      try {
        expect((await ingest(store)).status).toBe(200)
        expect((await signedIngest(store, { event: 'listen', id: ASK_ID, minutes: 1 }, 'device-integrity-b')).status).toBe(200)
        expect((await store.getAsk(ASK_ID))?.device_id).toBe(DEVICE)
        const events = await store.listEvents(10)
        expect(events.map((event) => event.kind).sort()).toEqual(['ask', 'listen'])
        expect(events.find((event) => event.kind === 'listen')?.device_id).toBe('device-integrity-b')
      } finally { close() }
    })

    it('keeps same-id activity from two signed devices separate while deduping retries', async () => {
      const { store, close } = testStore(kind)
      try {
        const payload = { event: 'recap', id: 'shared-client-id', minutes: 2 }
        expect((await signedIngest(store, payload, DEVICE)).status).toBe(200)
        expect((await signedIngest(store, payload, 'device-integrity-b')).status).toBe(200)
        expect((await signedIngest(store, payload, DEVICE)).status).toBe(200)
        const events = (await store.listEvents(10)).filter((event) => event.kind === 'recap')
        expect(events).toHaveLength(2)
        expect(new Set(events.map((event) => event.id)).size).toBe(2)
        expect(events.map((event) => event.device_id).sort()).toEqual([DEVICE, 'device-integrity-b'])
      } finally { close() }
    })

    it('repairs missing activity after an Ask row was written but activity was not', async () => {
      const { store, close } = testStore(kind)
      try {
        await meter(store, 'ask-partial-001')
        expect((await ingest(store, 'ask-partial-001')).status).toBe(200)
        expect((await store.listPulses(NOW - 1)).filter((p) => p.kind === 'ask')).toHaveLength(1)
        expect((await store.listEvents(10)).filter((e) => e.kind === 'ask')).toHaveLength(1)
      } finally { close() }
    })

    it('repairs an event missing after its activity pulse was committed', async () => {
      const { store, close } = testStore(kind)
      try {
        await meter(store)
        await store.insertPulse({
          id: `ask:${ASK_ID}`, device_id: DEVICE, ts: NOW + 1000, kind: 'ask',
          country: null, city: null, region: null
        })
        expect((await ingest(store)).status).toBe(200)
        expect((await store.listPulses(NOW - 1)).filter((p) => p.kind === 'ask')).toHaveLength(1)
        expect((await store.listEvents(10)).filter((e) => e.kind === 'ask')).toHaveLength(1)
      } finally { close() }
    })
  })
}
