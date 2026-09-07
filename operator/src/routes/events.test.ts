import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type AskRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'
import { parseKinds, parseLimit, resolveRange } from './events'

const NOW = 1_725_000_000_000

describe('parseLimit', () => {
  it('defaults to 50 when missing or non-numeric', () => {
    expect(parseLimit(null)).toBe(50)
    expect(parseLimit('')).toBe(50)
    expect(parseLimit('abc')).toBe(50)
  })

  it('clamps to [1, 200]', () => {
    expect(parseLimit('0')).toBe(1)
    expect(parseLimit('-5')).toBe(1)
    expect(parseLimit('500')).toBe(200)
    expect(parseLimit('75')).toBe(75)
  })
})

describe('parseKinds', () => {
  it('keeps only known kinds and drops unknown ones', () => {
    expect(parseKinds('heartbeat,ask,bogus')).toEqual(['heartbeat', 'ask'])
  })

  it('returns undefined when nothing valid remains, or nothing was given', () => {
    expect(parseKinds('bogus,also-bogus')).toBeUndefined()
    expect(parseKinds(null)).toBeUndefined()
  })
})

describe('resolveRange', () => {
  it('resolves a range preset server-side, taking precedence over an explicit since', () => {
    const params = new URLSearchParams({ range: '30m', since: '0' })
    const { since, until } = resolveRange(params, NOW)
    expect(until).toBe(NOW)
    expect(since).toBe(NOW - 30 * 60 * 1000)
  })

  it('defaults to the last 24h when nothing is given', () => {
    const { since, until } = resolveRange(new URLSearchParams(), NOW)
    expect(until).toBe(NOW)
    expect(since).toBe(NOW - 24 * 60 * 60 * 1000)
  })

  it('respects explicit since/until when no range preset is given', () => {
    const params = new URLSearchParams({ since: String(NOW - 1000), until: String(NOW) })
    const { since, until } = resolveRange(params, NOW)
    expect(since).toBe(NOW - 1000)
    expect(until).toBe(NOW)
  })
})

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'approved',
    approval: 'approved',
    ...overrides
  }
}

describe('GET /v1/admin/events.json', () => {
  it('paginates via nextCursor and joins seat fields (hostname, email, os, appVersion)', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    for (let i = 0; i < 3; i++) {
      await store.insertEvent({ id: `e${i}`, ts: NOW - i * 1000, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    }
    const first = await handleRequest(
      new Request('https://operator.test/v1/admin/events.json?limit=2'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(first.status).toBe(200)
    const body1 = (await first.json()) as {
      rows: { id: string; hostname: string | null; email: string | null; os: string | null; appVersion: string | null }[]
      nextCursor: string | null
      counts: Record<string, number>
    }
    expect(body1.rows).toHaveLength(2)
    expect(body1.rows[0]).toMatchObject({ hostname: 'Tonys-MacBook-Pro', email: 'twalteur@amaris.com', os: 'darwin', appVersion: '1.8.5' })
    expect(body1.nextCursor).toBeTruthy()
    expect(body1.counts.heartbeat).toBe(3)

    const second = await handleRequest(
      new Request(`https://operator.test/v1/admin/events.json?limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body2 = (await second.json()) as { rows: unknown[]; nextCursor: string | null }
    expect(body2.rows).toHaveLength(1)
    expect(body2.nextCursor).toBeNull()
  })

  it('filters by kinds and reports counts for the resolved range', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    await store.insertEvent({ id: 'e2', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'answer' })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/events.json?kinds=ask'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { rows: { kind: string }[]; counts: Record<string, number> }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].kind).toBe('ask')
    expect(body.counts).toEqual({ heartbeat: 1, ask: 1 })
  })

  it('never leaks prompt ciphertext or IVs', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'answer' })
    const res = await handleRequest(new Request('https://operator.test/v1/admin/events.json'), env(), { access: tonyAccess }, { store, now: NOW })
    const text = await res.text()
    expect(text).not.toMatch(/cipher/i)
    expect(text.toLowerCase()).not.toContain('prompt_iv')
  })

  it("joins an ask row's questionType from asks by (ts, device_id), never the prompt text", async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.insertEvent({ id: 'e-ask', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'answer' })
    await store.insertEvent({ id: 'e-hb', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', ts: NOW, question_type: 'behavioral' }))
    const res = await handleRequest(new Request('https://operator.test/v1/admin/events.json'), env(), { access: tonyAccess }, { store, now: NOW })
    const body = (await res.json()) as { rows: { id: string; kind: string; questionType: string | null }[] }
    const askRow = body.rows.find((r) => r.id === 'e-ask')
    const hbRow = body.rows.find((r) => r.id === 'e-hb')
    expect(askRow?.questionType).toBe('behavioral')
    expect(hbRow?.questionType).toBeNull()
  })
})

function ask(overrides: Partial<AskRow> & Pick<AskRow, 'id' | 'device_id'>): AskRow {
  return {
    ts: NOW,
    mode: 'answer',
    skill_id: null,
    skill_version: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    ttft_ms: null,
    total_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: 'answered',
    rating: null,
    prompt_cipher: 'super-secret-ciphertext',
    prompt_iv: 'iv-value',
    preview: 'this is the confidential prompt preview text nobody should see here',
    question_type: 'factual',
    ...overrides
  } as AskRow
}

describe('GET /v1/admin/events-stats.json', () => {
  it('aggregates event kinds, ask question types, providers, models, OS and client version for the resolved range and filters', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a', os: 'darwin', app_version: '1.8.5' }))
    await store.upsertSeat(seat({ device_id: 'dev-b', os: 'win', app_version: '1.8.4', hostname: 'DESKTOP-B', sso_email: 'b@amaris.com' }))
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    await store.insertEvent({ id: 'e2', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-b', country: 'CA', detail: null })
    await store.insertEvent({ id: 'e3', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'answer' })
    await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', ts: NOW, question_type: 'factual', provider: 'anthropic', model: 'claude-sonnet-4-6' }))
    await store.insertAsk(ask({ id: 'a2', device_id: 'dev-b', ts: NOW - 1000, question_type: 'code', provider: 'openai', model: 'gpt-5' }))

    const res = await handleRequest(new Request('https://operator.test/v1/admin/events-stats.json'), env(), { access: tonyAccess }, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      byKind: { key: string; count: number }[]
      askKindIncluded: boolean
      askCount: number
      questionTypes: { key: string; count: number }[]
      providers: { key: string; count: number }[]
      models: { key: string; count: number }[]
      os: { key: string; count: number }[]
      clientVersions: { key: string; count: number }[]
      series: { start: number; count: number }[]
      truncated: boolean
    }
    expect(body.byKind).toEqual(expect.arrayContaining([{ key: 'heartbeat', count: 2 }, { key: 'ask', count: 1 }]))
    expect(body.askKindIncluded).toBe(true)
    expect(body.askCount).toBe(2)
    expect(body.questionTypes).toEqual(expect.arrayContaining([{ key: 'Factual', count: 1 }, { key: 'Code', count: 1 }]))
    expect(body.providers).toEqual(expect.arrayContaining([{ key: 'anthropic', count: 1 }, { key: 'openai', count: 1 }]))
    expect(body.models[0].key).toMatch(/\//)
    expect(body.os).toEqual(expect.arrayContaining([{ key: 'macOS', count: 1 }, { key: 'Windows', count: 1 }]))
    expect(body.clientVersions).toEqual(expect.arrayContaining([{ key: '1.8.5', count: 1 }, { key: '1.8.4', count: 1 }]))
    expect(body.series.reduce((sum, p) => sum + p.count, 0)).toBeGreaterThan(0)
    expect(body.truncated).toBe(false)
  })

  it('empties every ask-derived breakdown, honestly, when the kind filter excludes ask', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', ts: NOW }))
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/events-stats.json?kinds=heartbeat'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { askKindIncluded: boolean; askCount: number; questionTypes: unknown[]; providers: unknown[]; models: unknown[] }
    expect(body.askKindIncluded).toBe(false)
    expect(body.askCount).toBe(0)
    expect(body.questionTypes).toEqual([])
    expect(body.providers).toEqual([])
    expect(body.models).toEqual([])
  })

  it('never leaks prompt ciphertext, IVs, or the question text', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'answer' })
    await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', ts: NOW }))
    const res = await handleRequest(new Request('https://operator.test/v1/admin/events-stats.json'), env(), { access: tonyAccess }, { store, now: NOW })
    const text = await res.text()
    expect(text).not.toMatch(/cipher/i)
    expect(text.toLowerCase()).not.toContain('prompt_iv')
    expect(text).not.toContain('this is the confidential prompt preview text')
  })
})
