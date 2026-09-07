import { describe, expect, it } from 'vitest'
import { buildDashboard, buildLiveSnapshot } from './dashboard'
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
