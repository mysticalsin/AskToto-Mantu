import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type AskRow, type SeatRow } from '../store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY } from '../test-fixtures'

const NOW = 1_725_000_000_000

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const tonyAccess = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW - 3_600_000,
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

function ask(overrides: Partial<AskRow> & Pick<AskRow, 'id' | 'device_id'>): AskRow {
  return {
    ts: NOW - 30_000,
    mode: 'answer',
    skill_id: null,
    skill_version: null,
    provider: 'anthropic',
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
    prompt_cipher: 'super-secret-ciphertext',
    prompt_iv: 'iv-value',
    preview: 'answer ask · Factual',
    question_type: 'factual',
    ...overrides
  }
}

describe('GET /v1/admin/sessions.json', () => {
  it('lists sessions with tier, live flag and profile fields', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 60_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })

    const res = await handleRequest(new Request('https://operator.test/v1/admin/sessions.json'), env(), { access: tonyAccess }, { store, now: NOW })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: { deviceId: string; tier: string | null; live: boolean; hostname: string | null }[] }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ deviceId: 'dev-a', tier: 'metis', live: true, hostname: 'Tonys-MacBook-Pro' })
  })

  it('applies country/os/q filters on top of the store page', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 60_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })

    const wrongCountry = await handleRequest(
      new Request('https://operator.test/v1/admin/sessions.json?country=US'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(((await wrongCountry.json()) as { rows: unknown[] }).rows).toHaveLength(0)

    const rightCountry = await handleRequest(
      new Request('https://operator.test/v1/admin/sessions.json?country=CA&os=darwin'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(((await rightCountry.json()) as { rows: unknown[] }).rows).toHaveLength(1)
  })
})

describe('GET /v1/admin/sessions/:id.json', () => {
  it('returns the session timeline with events and asks, never prompt text or ciphertext', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 60_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const session = await store.touchSession(
      'dev-a',
      NOW - 30_000,
      'ask',
      { country: 'CA', city: 'Longueuil' },
      { os: 'darwin', app_version: '1.8.5' }
    )
    await store.insertEvent({ id: 'ev-1', ts: NOW - 30_000, kind: 'ask', actor: null, device_id: 'dev-a', country: 'CA', detail: 'Customer Alpha private ask' })
    await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', preview: 'Patient diagnosis private prompt' }))

    const res = await handleRequest(
      new Request(`https://operator.test/v1/admin/sessions/${session.id}.json`),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('super-secret-ciphertext')
    expect(text).not.toContain('iv-value')
    expect(text.toLowerCase()).not.toContain('prompt_cipher')
    expect(text).not.toContain('Customer Alpha')
    expect(text).not.toContain('Patient diagnosis')

    const body = JSON.parse(text) as {
      session: { id: string; deviceId: string; tier: string | null }
      events: { id: string; detail: string | null }[]
      asks: { id: string; questionType: string | null }[]
    }
    expect(body.session.id).toBe(session.id)
    expect(body.session.deviceId).toBe('dev-a')
    expect(body.session.tier).toBe('metis')
    expect(body.events.some((e) => e.id === 'ev-1')).toBe(true)
    expect(body.events.find((e) => e.id === 'ev-1')?.detail).toBeNull()
    expect(body.asks).toHaveLength(1)
    expect(body.asks[0].id).toBe('a1')
  })

  it('404s for an unknown session id', async () => {
    const store = memoryStore()
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/sessions/nope.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(404)
  })
})
