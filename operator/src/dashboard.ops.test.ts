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

describe('overview ops tiles from real ingest only', () => {
  it('classifies CLI vs Operator-key asks and leaves time saved / listen unreported', async () => {
    const store = memoryStore()
    await store.upsertSeat({
      device_id: 'dev-a',
      seat_hash: 'seat',
      os: 'darwin',
      app_version: '1.8.2',
      first_seen: NOW - 3_600_000,
      last_seen: NOW,
      country: 'CA',
      city: 'Longueuil',
      lat: 45.5,
      lon: -73.5,
      last_index_at: null,
      hostname: 'Tonys-MacBook-Pro',
      sso_email: 'twalteur@amaris.com',
      license: 'approved'
    })
    await store.insertAsk(ask({ id: 'cli-1', provider: 'claude-cli', mode: 'answer' }))
    await store.insertAsk(ask({ id: 'op-1', provider: 'anthropic', mode: 'recap', total_ms: 40000 }))
    await store.insertAsk(ask({ id: 'unk-1', provider: 'mystery', mode: 'suggest', input_tokens: null, output_tokens: null, cache_read: null, cache_write: null, cache_uncached: null }))
    await store.insertEvent({
      id: 'listen-1',
      ts: NOW,
      kind: 'listen',
      actor: 'twalteur@amaris.com',
      device_id: 'dev-a',
      country: 'CA',
      detail: '12m'
    })
    const dash = await buildDashboard(store, 'tony.walteur@gmail.com', NOW)
    expect(dash.ops.uniqueSessions).toBe(1)
    expect(dash.ops.sessionsDay).toBe(1)
    expect(dash.ops.liveNow).toBe(1)
    expect(dash.ops.live30).toBe(1)
    expect(dash.ops.timeSaved).toBeNull()
    expect(dash.ops.durationMs).toBe(18000)
    expect(dash.ops.apiCalls).toBe(3)
    expect(dash.ops.cliAsks).toBe(1)
    expect(dash.ops.operatorAsks).toBe(1)
    expect(dash.ops.unknownAsks).toBe(1)
    expect(dash.ops.recapCount).toBe(1)
    expect(dash.ops.listenMinutes).toBe(12)
    expect(dash.ops.tokens).toBe(0)
    expect(dash.map.empty).toBe(false)
  })

  it('does not invent listen minutes or tokens when nothing was reported', async () => {
    const dash = await buildDashboard(memoryStore(), 'tony.walteur@gmail.com', NOW)
    expect(dash.ops.timeSaved).toBeNull()
    expect(dash.ops.listenMinutes).toBeNull()
    expect(dash.ops.tokens).toBe(0)
    expect(dash.ops.durationMs).toBeNull()
    expect(dash.ops.apiCalls).toBe(0)
    expect(dash.ops.cliAsks).toBe(0)
    expect(dash.ops.operatorAsks).toBe(0)
    expect(dash.map.empty).toBe(true)
    expect(dash.map.dots).toEqual([])
  })
})
