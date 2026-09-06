import { describe, expect, it } from 'vitest'
import { handleRequest, type Env } from '../index'
import { memoryStore, type SeatRow } from '../store'
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

describe('GET /v1/admin/live.json', () => {
  it('304s on a repeated If-None-Match, then 200s with a new ETag once the generation changes', async () => {
    const store = memoryStore()
    const first = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('cache-control')).toBe('no-store')
    const body1 = (await first.json()) as { ok: boolean; serverNow: number }
    expect(body1.ok).toBe(true)
    expect(body1.serverNow).toBe(NOW)

    const second = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json', { headers: { 'if-none-match': etag! } }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')

    // A heartbeat (any store mutation) changes buildLiveSnapshot's generation hash.
    await store.upsertSeat(seat({ device_id: 'dev-a' }))

    const third = await handleRequest(
      new Request('https://operator.test/v1/admin/live.json', { headers: { 'if-none-match': etag! } }),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(third.status).toBe(200)
    expect(third.headers.get('etag')).not.toBe(etag)
  })
})

describe('GET /v1/admin/realtime/live-seats.json', () => {
  it('lists seats with a heartbeat in the last 30 min, with tier, licenseState and session fields', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 30_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/live-seats.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      rows: { deviceId: string; tier: string | null; licenseState: string; live: boolean; hostname: string | null }[]
    }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ deviceId: 'dev-a', tier: 'metis', licenseState: 'licensed', live: true, hostname: 'Tonys-MacBook-Pro' })
  })

  it('excludes a seat whose last heartbeat is outside the 30 min window', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-old', last_seen: NOW - 60 * 60 * 1000 }))
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/live-seats.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toEqual([])
  })
})

describe('GET /v1/admin/realtime/geo.json', () => {
  it('groups seats/sessions/events by country + city with bounded 30-min and 2-min windows', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 30_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    await store.insertEvent({ id: 'e1', ts: NOW - 30_000, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime/geo.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: { country: string; city: string | null; events: number; liveSessions: number; seats30m: number }[] }
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({ country: 'CA', city: 'Longueuil', events: 1, liveSessions: 1, seats30m: 1 })
  })
})

describe('GET /v1/admin/realtime.geo.json (legacy alias)', () => {
  it('keeps returning the original { geo, regions } shape', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const res = await handleRequest(
      new Request('https://operator.test/v1/admin/realtime.geo.json'),
      env(),
      { access: tonyAccess },
      { store, now: NOW }
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; geo: unknown[]; regions: unknown[] }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.geo)).toBe(true)
    expect(Array.isArray(body.regions)).toBe(true)
  })
})
