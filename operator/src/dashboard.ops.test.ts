import { describe, expect, it } from 'vitest'
import { buildDashboard } from './dashboard'
import { memoryStore, type AskRow } from './store'

const NOW = 1_725_000_000_000

function ask(partial: Partial<AskRow> & Pick<AskRow, 'id' | 'provider' | 'mode'>): AskRow {
  return {
    device_id: 'dev-a',
    ts: NOW - 60_000,
    skill_id: null,
    skill_version: null,
    model: 'claude-sonnet',
    ttft_ms: 200,
    total_ms: 18000,
    input_tokens: 100,
    output_tokens: 20,
    cache_read: 0,
    cache_write: 0,
    cache_uncached: 100,
    cache_status: 'write',
    cache_ttl: null,
    outcome: null,
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: 'interview ask',
    ...partial
  }
}

describe('ROI and licenses from real D1 ingest only', () => {
  it('hides usage-import seats and fails loud when no real licenses exist', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'usage-deepseek-amaris',
      seat_hash: 'import',
      os: 'unknown',
      app_version: 'usage-import',
      first_seen: NOW,
      last_seen: NOW,
      country: null,
      city: null,
      lat: null,
      lon: null,
      last_index_at: null,
      hostname: null,
      sso_email: null,
      license: null
    })
    await store.insertAsk(
      ask({
        id: 'usage-1',
        device_id: 'usage-deepseek-amaris',
        provider: 'deepseek',
        mode: 'usage-import',
        cache_read: 1000,
        cache_uncached: 40
      })
    )
    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    expect(dash.profiles).toEqual([])
    expect(dash.licenses.empty).toBe(true)
    expect(dash.licenses.error).toBe('No licenses in D1')
    expect(dash.roi.liveSeats).toBe(0)
    expect(dash.roi.asksToday).toBeGreaterThanOrEqual(0)
    expect(dash.roi.source).toBe('d1.asks+d1.seats')
    expect(dash.roi.costToday).not.toBe('$0')
    expect(dash.map.empty).toBe(true)
  })

  it('lists real heartbeat seats with license + approval and real ROI', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'dev-a',
      seat_hash: 'seat',
      os: 'darwin',
      app_version: '1.8.3',
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
      approval: 'approved'
    })
    await store.insertAsk(ask({ id: 'op-1', provider: 'anthropic', mode: 'answer', cache_read: 800, cache_uncached: 40 }))
    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    expect(dash.roi.liveSeats).toBe(1)
    expect(dash.kpis.live).toBe(1)
    expect(dash.licenses.empty).toBe(false)
    expect(dash.licenses.rows[0]?.approval).toBe('approved')
    expect(dash.licenses.rows[0]?.license).toBe('licensed')
    expect(dash.profiles[0]?.hostname).toBe('Tonys-MacBook-Pro')
    expect(dash.profiles[0]?.email).toBe('twalteur@amaris.com')
    expect(dash.profiles[0]?.city).toBe('Longueuil')
    expect(dash.geo[0]).toMatchObject({
      country: 'CA',
      city: 'Longueuil',
      count: 1,
      unique_sessions: 1
    })
    expect(dash.roi.cacheHit).not.toBeNull()
    expect(dash.roi.costToday).not.toBe('$0')
    expect(dash.gateway.rows.some((r) => r.provider === 'anthropic')).toBe(true)
    expect(dash.roi.approved).toBe(1)
    expect(dash.roi.timeSaved).toBe('0 min')
    expect(dash.roi.timeSavedSub).toBe('no recaps ingested')
    expect(dash.roi.value).not.toBe('$0')
    expect(dash.events.some((e) => e.name === 'live' && e.chips.some((c) => c.value === 'Longueuil'))).toBe(true)
    expect(
      dash.events.some(
        (e) =>
          e.name === 'ask' &&
          e.hostname === 'Tonys-MacBook-Pro' &&
          e.chips.some((c) => c.key === 'city' && c.value === 'Longueuil') &&
          e.chips.some((c) => c.key === 'device')
      )
    ).toBe(true)
    expect(dash.notices.every((n) => 'profile' in n && 'city' in n && 'os' in n)).toBe(true)
  })

  it('does not invent cost when no asks were ingested', async () => {
    const dash = await buildDashboard(memoryStore(), 'tony.walteur@gmail.com', NOW)
    expect(dash.roi.costToday).toBeNull()
    expect(dash.roi.cost7d).toBeNull()
    expect(dash.roi.cacheHit).toBeNull()
    expect(dash.roi.liveSeats).toBe(0)
    expect(dash.licenses.empty).toBe(true)
    expect(dash.roi.timeSaved).toBe('0 min')
    expect(dash.roi.value).toBe('not reported')
  })

  it('credits time saved from recap minutes and keeps value from asks', async () => {
    const store = memoryStore()
    await store.insertEvent({
      id: 'recap-1',
      ts: NOW,
      kind: 'recap',
      actor: 'twalteur@amaris.com',
      device_id: 'dev-a',
      country: 'CA',
      detail: '60m'
    })
    await store.insertAsk(ask({ id: 'op-2', provider: 'anthropic', mode: 'answer' }))
    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    expect(dash.roi.timeSaved).toBe('12 min')
    expect(dash.roi.timeSavedSub).toBe('1 recaps · estimate')
    expect(dash.roi.value).not.toBe('not reported')
    expect(dash.roi.value).not.toBe('$0')
  })
})
