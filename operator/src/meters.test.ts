import { beforeEach, describe, expect, it } from 'vitest'
import { nextUtcMidnight, resolveSeatMeters, utcMidnight } from './meters'
import { memoryStore, type AskRow, type OperatorStore, type SeatRow } from './store'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const DEVICE = 'meter-device-0001'

function seat(patch: Partial<SeatRow> = {}): SeatRow {
  return {
    device_id: DEVICE,
    seat_hash: DEVICE,
    os: 'darwin',
    app_version: '2.12.0',
    first_seen: NOW,
    last_seen: NOW,
    country: null,
    city: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: null,
    sso_email: null,
    license: null,
    approval: 'approved',
    license_jti: null,
    ...patch
  } as SeatRow
}

function ask(id: string, patch: Partial<AskRow> = {}): AskRow {
  return {
    id,
    device_id: DEVICE,
    ts: utcMidnight(NOW) + 1000,
    mode: 'answer',
    skill_id: null,
    skill_version: null,
    provider: 'cloudflare',
    model: null,
    ttft_ms: null,
    total_ms: null,
    input_tokens: 100,
    output_tokens: 50,
    cache_read: null,
    cache_write: null,
    cache_uncached: null,
    cache_status: null,
    cache_ttl: null,
    outcome: 'answered',
    rating: null,
    prompt_cipher: null,
    prompt_iv: null,
    preview: null,
    question_type: null,
    path_tag: 'portal-cf',
    ...patch
  }
}

let store: OperatorStore
beforeEach(() => {
  store = memoryStore()
})

const budget = (n: number | null): Promise<void> =>
  store.putSetting('dailyTokenBudgetPerSeat', JSON.stringify(n), 'owner', NOW)

describe('resolveSeatMeters', () => {
  it('no meters when dailyTokenBudgetPerSeat is unset', async () => {
    await store.upsertSeat(seat())
    expect(await resolveSeatMeters(store, seat(), DEVICE, NOW)).toEqual([])
    await budget(null)
    expect(await resolveSeatMeters(store, seat(), DEVICE, NOW)).toEqual([])
  })

  it('no meter for a seat without operator_keys', async () => {
    await budget(1000)
    const pending = seat({ approval: 'pending' })
    expect(await resolveSeatMeters(store, pending, DEVICE, NOW)).toEqual([])
  })

  it('managed_tokens meter with limit, used and next UTC midnight resetAt', async () => {
    await budget(1000)
    await store.insertAsk(ask('a1'))
    await store.insertAsk(ask('a2', { path_tag: 'portal-direct', input_tokens: 10, output_tokens: null }))
    expect(await resolveSeatMeters(store, seat(), DEVICE, NOW)).toEqual([
      {
        id: 'managed_tokens',
        label: 'Managed AI tokens',
        unit: 'tokens',
        limit: 1000,
        used: 160,
        resetAt: utcMidnight(NOW) + DAY,
        window: 'day'
      }
    ])
    expect(nextUtcMidnight(NOW)).toBe(utcMidnight(NOW) + DAY)
  })

  it('cli and seat-local asks do not count, nor asks before today', async () => {
    await budget(1000)
    await store.insertAsk(ask('c1', { path_tag: 'cli' }))
    await store.insertAsk(ask('s1', { path_tag: 'seat-local' }))
    await store.insertAsk(ask('old', { ts: utcMidnight(NOW) - 1 }))
    const [meter] = await resolveSeatMeters(store, seat(), DEVICE, NOW)
    expect(meter.used).toBe(0)
  })

  it("another device's asks do not count", async () => {
    await budget(1000)
    await store.insertAsk(ask('other', { device_id: 'meter-device-0002' }))
    const [meter] = await resolveSeatMeters(store, seat(), DEVICE, NOW)
    expect(meter.used).toBe(0)
  })

  it('used is null when the sum query throws', async () => {
    await budget(1000)
    const broken: OperatorStore = {
      ...store,
      sumSeatManagedTokensSince: async () => {
        throw new Error('no such column: path_tag')
      }
    }
    const [meter] = await resolveSeatMeters(broken, seat(), DEVICE, NOW)
    expect(meter).toMatchObject({ limit: 1000, used: null })
  })
})
