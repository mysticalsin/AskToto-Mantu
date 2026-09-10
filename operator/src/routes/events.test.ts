import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type SeatRow } from '../store'
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

  it('suppresses content-bearing detail from legacy Ask, CRM, and heartbeat rows', async () => {
    const store = memoryStore()
    await store.insertEvent({ id: 'a', ts: NOW, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'Customer Alpha private ask' })
    await store.insertEvent({ id: 'c', ts: NOW - 1, kind: 'crm', actor: null, device_id: 'dev-a', country: 'CA', detail: 'Patient diagnosis CRM payload' })
    await store.insertEvent({ id: 'h', ts: NOW - 2, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: '/Users/tony/private.md' })
    const res = await handleRequest(new Request('https://operator.test/v1/admin/events.json'), env(), { access: tonyAccess }, { store, now: NOW })
    const body = (await res.json()) as { rows: { id: string; detail: string | null }[] }
    expect(body.rows.map((row) => row.detail)).toEqual([null, null, null])
    expect(JSON.stringify(body)).not.toContain('Customer Alpha')
    expect(JSON.stringify(body)).not.toContain('Patient diagnosis')
    expect(JSON.stringify(body)).not.toContain('/Users/tony')
  })
})
