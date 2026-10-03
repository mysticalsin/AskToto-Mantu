import { beforeEach, describe, expect, it } from 'vitest'
import { d1Store } from './d1'
import { memoryStore, type AskRow, type OperatorStore, type SeatRow } from './store'
import { migratedDb, sqliteD1 } from './test-d1'

/** One OperatorStore contract, run against every implementation: the in-memory store the tests inject and
 *  the D1 store the Worker serves from (real SQLite at the migration head). A behaviour one backend has and
 *  the other lacks fails here, so tests written against memoryStore cannot drift from production. */
const BACKENDS: ReadonlyArray<readonly [string, () => OperatorStore]> = [
  ['memoryStore', () => memoryStore()],
  ['d1Store', () => d1Store(sqliteD1(migratedDb()))]
]

function seat(deviceId: string, overrides: Partial<SeatRow> = {}): SeatRow {
  return {
    device_id: deviceId,
    seat_hash: 'seat',
    os: 'darwin',
    app_version: '1.8.5',
    first_seen: 1000,
    last_seen: 1000,
    country: 'CA',
    city: null,
    region: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: 'host',
    sso_email: 'admin@example.test',
    license: 'licensed',
    approval: 'pending',
    license_jti: null,
    ...overrides
  }
}

function ask(id: string, overrides: Partial<AskRow> = {}): AskRow {
  return {
    id,
    device_id: 'dev-a',
    ts: 1000,
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

describe.each(BACKENDS)('OperatorStore contract: %s', (_name, make) => {
  let store: OperatorStore
  beforeEach(() => {
    store = make()
  })

  it('accepts a nonce once and reports every replay', async () => {
    expect(await store.takeNonce('n-1', 1000)).toBe(false)
    expect(await store.takeNonce('n-1', 1001)).toBe(true)
    expect(await store.takeNonce('n-2', 1001)).toBe(false)
  })

  it('rate-limits a key once it exceeds max inside a window and resets in the next', async () => {
    expect(await store.hitRate('k', 1000, 60_000, 2)).toBe(false)
    expect(await store.hitRate('k', 1001, 60_000, 2)).toBe(false)
    expect(await store.hitRate('k', 1002, 60_000, 2)).toBe(true)
    expect(await store.hitRate('k', 200_000, 60_000, 2)).toBe(false)
  })

  it('round-trips a seat and updates its approval', async () => {
    await store.upsertSeat(seat('dev-a'))
    expect((await store.getSeat('dev-a'))?.hostname).toBe('host')
    expect(await store.getSeat('missing')).toBeNull()
    expect(await store.updateSeatApproval('dev-a', 'approved')).toBe(true)
    expect((await store.getSeat('dev-a'))?.approval).toBe('approved')
    expect(await store.updateSeatApproval('missing', 'approved')).toBe(false)
    expect((await store.listSeats()).map((s) => s.device_id)).toEqual(['dev-a'])
  })

  it('stores an ask once per owner, lists newest first and applies a rating', async () => {
    expect(await store.insertAsk(ask('a-1', { ts: 1000 }))).toBe(true)
    expect(await store.insertAsk(ask('a-1', { device_id: 'dev-b' }))).toBe(false)
    await store.insertAsk(ask('a-2', { ts: 2000 }))
    expect((await store.listAsks(10)).map((a) => a.id)).toEqual(['a-2', 'a-1'])
    expect((await store.listAsks(10, 1500)).map((a) => a.id)).toEqual(['a-2'])
    await store.updateAskRating('a-1', 'up')
    expect((await store.getAsk('a-1'))?.rating).toBe('up')
    expect(await store.getAsk('missing')).toBeNull()
  })

  it('records audit rows newest first with an action filter', async () => {
    await store.audit('e-1', 1000, 'system', 'platform.heartbeat', null, 'first')
    await store.audit('e-2', 2000, 'admin@example.test', 'approve', null, 'second')
    expect((await store.listAudit(10)).map((r) => r.detail)).toEqual(['second', 'first'])
    expect((await store.listAudit(10, { action: 'platform.heartbeat' })).map((r) => r.detail)).toEqual(['first'])
  })
})
