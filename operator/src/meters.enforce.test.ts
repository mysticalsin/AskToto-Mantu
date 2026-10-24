import { beforeEach, describe, expect, it } from 'vitest'
import { checkManagedBudget, readDailyBudget, utcMidnight } from './meters'
import { memoryStore, type AskRow, type OperatorStore, type SeatRow } from './store'

const NOW = 1_800_000_000_000
const DEVICE = 'enforce-device-0001'

const seat = (patch: Partial<SeatRow> = {}): SeatRow =>
  ({
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
  }) as SeatRow

const ask = (id: string, tokens: number): AskRow => ({
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
  input_tokens: tokens,
  output_tokens: 0,
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
  path_tag: 'portal-cf'
})

let store: OperatorStore
beforeEach(() => {
  store = memoryStore()
})
const budget = (n: number | null) => store.putSetting('dailyTokenBudgetPerSeat', JSON.stringify(n), 'owner', NOW)

describe('checkManagedBudget (G81)', () => {
  it('checkManagedBudget allows below limit', async () => {
    await budget(1000)
    await store.insertAsk(ask('a1', 999))
    expect(await checkManagedBudget(store, seat(), DEVICE, NOW)).toEqual({ ok: true })
  })

  it('refuses at limit', async () => {
    await budget(1000)
    await store.insertAsk(ask('a1', 1000))
    const res = await checkManagedBudget(store, seat(), DEVICE, NOW)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.meter).toMatchObject({ id: 'managed_tokens', limit: 1000, used: 1000 })
  })

  it('refuses a zero budget at zero use', async () => {
    await budget(0)
    expect((await checkManagedBudget(store, seat(), DEVICE, NOW)).ok).toBe(false)
  })

  it('allows when used is null', async () => {
    await budget(1000)
    const broken: OperatorStore = {
      ...store,
      sumSeatManagedTokensSince: async () => {
        throw new Error('no such column: path_tag')
      }
    }
    expect(await checkManagedBudget(broken, seat(), DEVICE, NOW)).toEqual({ ok: true })
  })

  it('allows when no budget or no operator_keys entitlement', async () => {
    expect(await checkManagedBudget(store, seat(), DEVICE, NOW)).toEqual({ ok: true })
    await budget(1)
    await store.insertAsk(ask('a1', 500))
    expect(await checkManagedBudget(store, seat({ approval: 'pending' }), DEVICE, NOW)).toEqual({ ok: true })
  })

  it('readDailyBudget reads the setting and is null when unset or corrupt', async () => {
    expect(await readDailyBudget(store)).toBeNull()
    await budget(42)
    expect(await readDailyBudget(store)).toBe(42)
    await store.putSetting('dailyTokenBudgetPerSeat', '"nope"', 'owner', NOW)
    expect(await readDailyBudget(store)).toBeNull()
  })
})
