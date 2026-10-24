import { describe, expect, it, vi } from 'vitest'
import { runNightly } from './cron'
import { utcMidnight } from './meters'
import { looksLikeSecret } from './redact'
import { memoryStore } from './store'
import { listUsageDay } from './usage-reconcile'
import { putAsk, sqliteD1, usageDb } from './usage-test-kit'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000 + 3 * 60 * 60 * 1000
const TODAY = utcMidnight(NOW)

describe('runNightly (G81)', () => {
  it('runNightly reconciles yesterday and today after retention', async () => {
    const raw = usageDb()
    putAsk(raw, {
      id: 'y',
      device_id: 'cron-device-0001',
      ts: TODAY - 100,
      input_tokens: 10,
      output_tokens: 5,
      path_tag: 'portal-cf'
    })
    putAsk(raw, {
      id: 't',
      device_id: 'cron-device-0001',
      ts: TODAY + 100,
      input_tokens: 1,
      output_tokens: 1,
      path_tag: 'portal-direct'
    })
    const db = sqliteD1(raw)
    const log = vi.fn()
    const out = await runNightly(memoryStore(), db, NOW, log)
    expect(out.retention).toBe(true)
    expect(out.reconciled).toEqual([
      { day: TODAY - DAY_MS, ok: true, seats: 1, drift: 15 },
      { day: TODAY, ok: true, seats: 1, drift: 2 }
    ])
    expect((await listUsageDay(db, TODAY - DAY_MS))[0]).toMatchObject({ used: 15 })
    expect((await listUsageDay(db, TODAY))[0]).toMatchObject({ used: 2 })
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ t: 'reconcile', ok: true }))
  })

  it('a reconcile failure is logged and does not throw', async () => {
    const log = vi.fn()
    const out = await runNightly(memoryStore(), sqliteD1(usageDb({ withUsage: false })), NOW, log)
    expect(out.reconciled.every((r) => !r.ok)).toBe(true)
    const lines = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((l) => l.t === 'reconcile')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ t: 'reconcile', ok: false, error: 'not migrated' })
    expect(looksLikeSecret(JSON.stringify(lines))).toBe(false)
  })

  it('a retention failure is logged and reconcile still runs', async () => {
    const store = memoryStore()
    store.pruneTable = async () => {
      throw new Error('boom')
    }
    const log = vi.fn()
    const out = await runNightly(store, sqliteD1(usageDb()), NOW, log)
    expect(out.retention).toBe(false)
    expect(out.reconciled).toHaveLength(2)
    expect(log).toHaveBeenCalledWith({ t: 'retention', ok: false, error: 'retention failed' })
  })

  it('works without a usable DB handle (logs, never throws)', async () => {
    const log = vi.fn()
    const out = await runNightly(memoryStore(), undefined, NOW, log)
    expect(out.reconciled.every((r) => !r.ok)).toBe(true)
  })
})
