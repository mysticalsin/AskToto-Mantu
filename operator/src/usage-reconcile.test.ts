import { describe, expect, it } from 'vitest'
import { utcMidnight } from './meters'
import { listUsageDay, reconcileUsageDay } from './usage-reconcile'
import { putAsk, sqliteD1, usageDb } from './usage-test-kit'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000
const DAY = utcMidnight(NOW)
const A = 'usage-device-0001'
const B = 'usage-device-0002'

const ask = (id: string, device_id: string, patch: Partial<Parameters<typeof putAsk>[1]> = {}) => ({
  id,
  device_id,
  ts: DAY + 1000,
  input_tokens: 100,
  output_tokens: 50,
  path_tag: 'portal-cf',
  ...patch
})

function setup() {
  const raw = usageDb()
  return { raw, db: sqliteD1(raw) }
}

describe('reconcileUsageDay (G81)', () => {
  it('reconciles portal-cf and portal-direct tokens per device for one UTC day', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A))
    putAsk(raw, ask('a2', A, { path_tag: 'portal-direct', input_tokens: 10, output_tokens: null }))
    putAsk(raw, ask('b1', B, { input_tokens: 7, output_tokens: 3 }))
    const res = await reconcileUsageDay(db, DAY, NOW)
    expect(res).toMatchObject({ ok: true, day: DAY, seats: 2 })
    const rows = await listUsageDay(db, DAY)
    expect(rows).toEqual([
      { device_id: A, day: DAY, meter_id: 'managed_tokens', used: 160, asks: 2, unknown_asks: 0, reconciled_at: NOW },
      { device_id: B, day: DAY, meter_id: 'managed_tokens', used: 10, asks: 1, unknown_asks: 0, reconciled_at: NOW }
    ])
  })

  it('ignores cli and seat-local asks and asks outside the day', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('c', A, { path_tag: 'cli' }))
    putAsk(raw, ask('s', A, { path_tag: 'seat-local' }))
    putAsk(raw, ask('n', A, { path_tag: null }))
    putAsk(raw, ask('early', A, { ts: DAY - 1 }))
    putAsk(raw, ask('late', A, { ts: DAY + DAY_MS }))
    expect(await reconcileUsageDay(db, DAY, NOW)).toMatchObject({ ok: true, seats: 0 })
    expect(await listUsageDay(db, DAY)).toEqual([])
  })

  it('is idempotent: second run yields identical rows and drift 0', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A))
    const first = await reconcileUsageDay(db, DAY, NOW)
    const rows1 = await listUsageDay(db, DAY)
    const second = await reconcileUsageDay(db, DAY, NOW)
    expect(first).toMatchObject({ ok: true, drift: 150 })
    expect(second).toMatchObject({ ok: true, drift: 0, seats: 1 })
    expect(await listUsageDay(db, DAY)).toEqual(rows1)
  })

  it('an ask replay with the same id does not double count', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A))
    await reconcileUsageDay(db, DAY, NOW)
    putAsk(raw, ask('a1', A))
    const res = await reconcileUsageDay(db, DAY, NOW + 5)
    expect(res).toMatchObject({ ok: true, drift: 0 })
    expect((await listUsageDay(db, DAY))[0]).toMatchObject({ used: 150, asks: 1 })
  })

  it('a late ask raises used and reports drift', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A))
    await reconcileUsageDay(db, DAY, NOW)
    putAsk(raw, ask('a2', A, { input_tokens: 20, output_tokens: 5 }))
    const res = await reconcileUsageDay(db, DAY, NOW + 10)
    expect(res).toMatchObject({ ok: true, drift: 25 })
    expect((await listUsageDay(db, DAY))[0]).toMatchObject({ used: 175, asks: 2, reconciled_at: NOW + 10 })
  })

  it('a device with no remaining asks is removed on recompute', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A))
    putAsk(raw, ask('b1', B))
    await reconcileUsageDay(db, DAY, NOW)
    raw.prepare('DELETE FROM asks WHERE id = ?').run('b1')
    const res = await reconcileUsageDay(db, DAY, NOW + 1)
    expect(res).toMatchObject({ ok: true, seats: 1, drift: 150 })
    expect((await listUsageDay(db, DAY)).map((r) => r.device_id)).toEqual([A])
  })

  it('counts null-token asks as unknown_asks, never as tokens', async () => {
    const { raw, db } = setup()
    putAsk(raw, ask('a1', A, { input_tokens: null, output_tokens: null }))
    putAsk(raw, ask('a2', A, { input_tokens: 5, output_tokens: 5 }))
    await reconcileUsageDay(db, DAY, NOW)
    expect((await listUsageDay(db, DAY))[0]).toMatchObject({ used: 10, asks: 2, unknown_asks: 1 })
  })

  it('returns not migrated when asks.path_tag or the table is missing', async () => {
    const noTable = usageDb({ withUsage: false })
    expect(await reconcileUsageDay(sqliteD1(noTable), DAY, NOW)).toEqual({ ok: false, error: 'not migrated' })
    const noTag = usageDb()
    noTag.exec('ALTER TABLE asks DROP COLUMN path_tag')
    expect(await reconcileUsageDay(sqliteD1(noTag), DAY, NOW)).toEqual({ ok: false, error: 'not migrated' })
    expect(await reconcileUsageDay(undefined, DAY, NOW)).toEqual({ ok: false, error: 'db unbound' })
  })

  it('rejects a non-midnight, future or >31-day-old day', async () => {
    const { db } = setup()
    for (const bad of [DAY + 1, DAY + DAY_MS, DAY - 32 * DAY_MS, -DAY, Number.NaN]) {
      expect(await reconcileUsageDay(db, bad, NOW)).toEqual({ ok: false, error: 'invalid day' })
    }
    expect(await reconcileUsageDay(db, DAY - 31 * DAY_MS, NOW)).toMatchObject({ ok: true })
  })
})
