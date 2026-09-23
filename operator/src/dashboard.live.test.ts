import { describe, expect, it } from 'vitest'
import { buildDashboard, buildLiveSnapshot } from './dashboard'
import { placeKey } from './realtime-geo'
import { memoryStore, type AskRow, type SeatRow } from './store'

const NOW = 1_725_000_000_000

function seat(overrides: Partial<SeatRow> & Pick<SeatRow, 'device_id'>): SeatRow {
  return {
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: NOW - 3_600_000,
    last_seen: NOW,
    country: 'CA',
    city: 'Longueuil',
    lat: 45.5,
    lon: -73.5,
    last_index_at: null,
    hostname: 'Tonys-MacBook-Pro',
    sso_email: 'twalteur@amaris.com',
    license: 'licensed',
    approval: 'approved',
    ...overrides
  }
}

function ask(overrides: Partial<AskRow> & Pick<AskRow, 'id'>): AskRow {
  return {
    device_id: 'dev-a',
    ts: NOW - 60_000,
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
    prompt_cipher: null,
    prompt_iv: null,
    preview: null,
    question_type: null,
    ...overrides
  }
}

describe('buildLiveSnapshot', () => {
  it('returns a compact, bounded snapshot for polling', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.touchSession('dev-a', NOW - 60_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
    await store.insertEvent({ id: 'e1', ts: NOW, kind: 'heartbeat', actor: null, device_id: 'dev-a', country: 'CA', detail: null })
    await store.insertAsk(ask({ id: 'a1' }))

    const snap = await buildLiveSnapshot(store, NOW)
    expect(snap.liveSeats).toBe(1)
    expect(snap.seats30m).toBe(1)
    expect(snap.kpis.live).toBe(1)
    expect(snap.kpis.asksToday).toBe(1)
    expect(snap.events.length).toBeGreaterThan(0)
    expect(snap.liveSeatsTable).toHaveLength(1)
    expect(snap.liveSeatsTable[0]).toMatchObject({ deviceId: 'dev-a', hostname: 'Tonys-MacBook-Pro', city: 'Longueuil' })
    expect(snap.liveSeatsTable[0].sessionStarted).toBe(NOW - 60_000)
    expect(typeof snap.generation).toBe('number')
  })

  it('generation is stable for identical input and changes when the underlying data changes', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    const snap1 = await buildLiveSnapshot(store, NOW)
    const snap2 = await buildLiveSnapshot(store, NOW)
    expect(snap2.generation).toBe(snap1.generation)
    await store.insertAsk(ask({ id: 'a1' }))
    const snap3 = await buildLiveSnapshot(store, NOW)
    expect(snap3.generation).not.toBe(snap1.generation)
  })

  it('never touches unbounded history: an old ask outside the day window does not appear in asksToday', async () => {
    const store = memoryStore()
    await store.insertAsk(ask({ id: 'old', ts: NOW - 30 * 24 * 60 * 60 * 1000 }))
    const snap = await buildLiveSnapshot(store, NOW)
    expect(snap.kpis.asksToday).toBe(0)
  })
})

const PLACE_KEYS = ['city', 'country', 'iso2', 'lat', 'lon', 'region', 'seats', 'sessions']
const RECENT_EVENT_KEYS = ['actor', 'appVersion', 'city', 'country', 'id', 'kind', 'os', 'ts']
const SECRET_DETAIL = 'SECRET-DETAIL-TEXT-9f1c'
const SECRET_PROMPT = 'PROMPT-SECRET-TEXT-4b2e'

async function realtimeStore() {
  const store = memoryStore()
  // Two seats at one place (same city + coords), one open session there.
  await store.upsertSeat(seat({ device_id: 'dev-a', region: 'Quebec' }))
  await store.upsertSeat(seat({ device_id: 'dev-b', last_seen: NOW - 60_000 }))
  // Another place, 10 min ago.
  await store.upsertSeat(seat({ device_id: 'dev-c', country: 'FR', city: 'Paris', lat: 48.8566, lon: 2.3522, last_seen: NOW - 10 * 60_000 }))
  // Excluded: no coordinates, too old, not an ISO2 country.
  await store.upsertSeat(seat({ device_id: 'dev-nogeo', country: 'US', city: 'Ashburn', lat: null, lon: null }))
  await store.upsertSeat(seat({ device_id: 'dev-old', country: 'DE', city: 'Berlin', lat: 52.52, lon: 13.405, last_seen: NOW - 2 * 3_600_000 }))
  await store.upsertSeat(seat({ device_id: 'dev-badiso', country: 'Canada', city: 'Ottawa', lat: 45.42, lon: -75.69 }))
  await store.touchSession('dev-a', NOW - 60_000, 'heartbeat', { country: 'CA', city: 'Longueuil' }, { os: 'darwin', app_version: '1.8.5' })
  for (let i = 0; i < 55; i++) {
    await store.insertEvent({
      id: `e${String(i).padStart(2, '0')}`,
      ts: NOW - i * 1000,
      kind: i % 2 ? 'listen' : 'ask',
      actor: null,
      device_id: i % 3 ? 'dev-a' : 'dev-c',
      country: null,
      detail: `${SECRET_DETAIL} ${i}`
    })
  }
  await store.insertAsk(ask({ id: 'a1', device_id: 'dev-a', mode: 'interview', skill_id: 'recruiting-pack', preview: SECRET_PROMPT }))
  await store.insertAsk(ask({ id: 'a2', device_id: 'dev-b', mode: 'interview', preview: SECRET_PROMPT }))
  await store.insertAsk(ask({ id: 'a3', device_id: 'dev-c', mode: 'sales', ts: NOW - 5 * 60_000 }))
  // Outside the 30 min window: must not count.
  await store.insertAsk(ask({ id: 'a-old', device_id: 'dev-a', mode: 'answer', ts: NOW - 45 * 60_000 }))
  return store
}

describe('live.json realtime contract (PLAN.md Rock 1)', () => {
  it('geo.places: exactly 8 keys, ISO2 codes, valid lat/lon, recent seats with coordinates only', async () => {
    const snap = await buildLiveSnapshot(await realtimeStore(), NOW)
    expect(snap.geo.asOf).toBe(NOW)
    expect(snap.geo.asOf).toBe(snap.now)
    expect(snap.geo.liveSeats).toBe(snap.liveSeats)
    expect(snap.geo.places.length).toBe(2)
    for (const p of snap.geo.places) {
      expect(Object.keys(p).sort()).toEqual(PLACE_KEYS)
      expect(p.iso2).toMatch(/^[A-Z]{2}$/)
      expect(p.lat).toBeGreaterThanOrEqual(-90)
      expect(p.lat).toBeLessThanOrEqual(90)
      expect(p.lon).toBeGreaterThanOrEqual(-180)
      expect(p.lon).toBeLessThanOrEqual(180)
    }
    const [ca, fr] = snap.geo.places
    expect(ca).toEqual({ iso2: 'CA', country: 'Canada', region: 'Quebec', city: 'Longueuil', lat: 45.5, lon: -73.5, seats: 2, sessions: 1 })
    expect(fr).toMatchObject({ iso2: 'FR', country: 'France', city: 'Paris', lat: 48.86, lon: 2.35, seats: 1, sessions: 0 })
    const isos = snap.geo.places.map((p) => p.iso2)
    expect(isos).not.toContain('US') // no lat/lon
    expect(isos).not.toContain('DE') // older than 30 min
    expect(snap.geo.places.some((p) => p.city === 'Ottawa')).toBe(false) // country is not ISO2
  })

  it('recentEvents: at most 50, newest first, metadata only (no detail / preview / prompt text)', async () => {
    const snap = await buildLiveSnapshot(await realtimeStore(), NOW)
    expect(snap.recentEvents.length).toBe(50)
    for (let i = 1; i < snap.recentEvents.length; i++) {
      expect(snap.recentEvents[i - 1].ts).toBeGreaterThanOrEqual(snap.recentEvents[i].ts)
    }
    expect(snap.recentEvents[0]).toMatchObject({ id: 'e00', ts: NOW, kind: 'ask', country: 'FR', city: 'Paris' })
    for (const e of snap.recentEvents) {
      expect(Object.keys(e).sort()).toEqual(RECENT_EVENT_KEYS)
      expect(e).not.toHaveProperty('detail')
      expect(e).not.toHaveProperty('preview')
      expect(e).not.toHaveProperty('prompt')
    }
    const json = JSON.stringify(snap.recentEvents)
    expect(json).not.toContain(SECRET_DETAIL)
    expect(json).not.toContain(SECRET_PROMPT)
  })

  it('placeActivity: keys are a subset of place keys, last 30 min only, names never prompt text', async () => {
    const snap = await buildLiveSnapshot(await realtimeStore(), NOW)
    const keys = new Set(snap.geo.places.map(placeKey))
    expect(Object.keys(snap.placeActivity).length).toBeGreaterThan(0)
    for (const k of Object.keys(snap.placeActivity)) expect(keys.has(k)).toBe(true)
    const ca = snap.placeActivity[placeKey(snap.geo.places[0])]
    expect(ca.modes).toEqual([['interview', 2]])
    expect(ca.skills).toEqual([['recruiting-pack', 1]])
    const fr = snap.placeActivity[placeKey(snap.geo.places[1])]
    expect(fr.modes).toEqual([['sales', 1]])
    expect(JSON.stringify(snap.placeActivity)).not.toContain(SECRET_PROMPT)
    expect(JSON.stringify(snap.placeActivity)).not.toContain('answer') // a-old is outside the window
  })

  it('the SSR payload (DashboardPayload.realtime) is built from the same functions as live.json', async () => {
    const store = await realtimeStore()
    const [snap, dash] = await Promise.all([buildLiveSnapshot(store, NOW), buildDashboard(store, 'tony.walteur@gmail.com', NOW)])
    expect(dash.realtime.places).toEqual(snap.geo.places)
    expect(dash.realtime.placeActivity).toEqual(snap.placeActivity)
    expect(dash.realtime.liveSeats).toBe(snap.liveSeats)
    expect(dash.realtime.recentEvents).toEqual(snap.recentEvents)
  })

  it('an empty store yields an empty map, never sample places', async () => {
    const snap = await buildLiveSnapshot(memoryStore(), NOW)
    expect(snap.geo).toEqual({ places: [], liveSeats: 0, asOf: NOW })
    expect(snap.recentEvents).toEqual([])
    expect(snap.placeActivity).toEqual({})
  })
})

describe('DashboardPayload.questions', () => {
  it('aggregates question types overall and by mode, with honest coverage', async () => {
    const store = memoryStore()
    await store.upsertSeat(seat({ device_id: 'dev-a' }))
    await store.insertAsk(ask({ id: 'a1', mode: 'answer', question_type: 'factual' }))
    await store.insertAsk(ask({ id: 'a2', mode: 'answer', question_type: 'factual' }))
    await store.insertAsk(ask({ id: 'a3', mode: 'interview', question_type: 'behavioral' }))
    await store.insertAsk(ask({ id: 'a4', mode: 'interview', question_type: null }))

    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    expect(dash.questions.mix.total).toBe(4)
    expect(dash.questions.mix.classified).toBe(3)
    expect(dash.questions.coverage).toBeCloseTo(0.75)
    const answerMode = dash.questions.byMode.find((m) => m.mode === 'answer')
    expect(answerMode?.mix.bars).toEqual([{ type: 'factual', label: 'Factual', count: 2 }])
    const interviewMode = dash.questions.byMode.find((m) => m.mode === 'interview')
    expect(interviewMode?.mix.classified).toBe(1)
    expect(interviewMode?.mix.total).toBe(2)
  })

  it('reports zero/null honestly when no asks carry a type', async () => {
    const dash = await buildDashboard(memoryStore(), 'tony.walteur@gmail.com', NOW)
    expect(dash.questions.mix.total).toBe(0)
    expect(dash.questions.mix.coverage).toBeNull()
    expect(dash.questions.byMode).toEqual([])
  })
})
