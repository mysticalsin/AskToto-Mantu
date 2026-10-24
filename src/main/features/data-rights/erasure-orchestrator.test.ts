import { describe, expect, it } from 'vitest'
import { DATA_STORES, type DataStoreId } from '@shared/data-store-inventory'
import { runErasure, type ErasureDeps, type StoreEraser } from './erasure-orchestrator'

const ok = (count = 1): StoreEraser => ({ erase: async () => ({ outcome: 'erased', count }) })

function allErasers(log: string[] = []): Partial<Record<DataStoreId, StoreEraser>> {
  const map: Partial<Record<DataStoreId, StoreEraser>> = {}
  for (const entry of DATA_STORES) {
    if (entry.erase !== 'delete') continue
    map[entry.id] = {
      erase: async () => {
        log.push(`erase:${entry.id}:p${entry.phase}`)
        return { outcome: 'erased', count: 1 }
      }
    }
  }
  return map
}

function deps(over: Partial<ErasureDeps> = {}): ErasureDeps & { audits: Record<string, unknown>[] } {
  const audits: Record<string, unknown>[] = []
  let n = 0
  return {
    erasers: allErasers(),
    writeFence: async () => true,
    quiesce: async () => undefined,
    now: () => 1_000 + n++,
    newId: () => 'a'.repeat(32),
    audit: (record) => void audits.push(record),
    audits,
    ...over
  }
}

describe('runErasure (G82)', () => {
  it('phases in order, fence before phase 2', async () => {
    const log: string[] = []
    await runErasure(
      deps({
        erasers: allErasers(log),
        writeFence: async () => {
          log.push('fence')
          return true
        },
        quiesce: async () => void log.push('quiesce')
      })
    )
    expect(log[0]).toBe('fence')
    expect(log[1]).toBe('quiesce')
    const phases = log.filter((l) => l.startsWith('erase:')).map((l) => Number(l.split(':p')[1]))
    expect(phases).toEqual([...phases].sort((a, b) => a - b))
    expect(log.indexOf('fence')).toBeLessThan(log.findIndex((l) => l.includes(':p2')))
  })

  it('one failure never stops the rest', async () => {
    const erasers = allErasers()
    erasers.assistants = {
      erase: async () => {
        throw new Error('/Users/someone/secret.bin could not be removed for a@b.com')
      }
    }
    const result = await runErasure(deps({ erasers }))
    expect(result.stores.find((s) => s.store === 'assistants')?.outcome).toBe('failed')
    expect(result.stores.find((s) => s.store === 'user-memory')?.outcome).toBe('erased')
    expect(result.failed).toBe(1)
  })

  it('shared eraser runs once', async () => {
    let runs = 0
    const shared: StoreEraser = {
      erase: async () => {
        runs += 1
        return { outcome: 'erased', count: 2 }
      }
    }
    const erasers = allErasers()
    erasers.brain = shared
    erasers['brain-backup'] = shared
    erasers['brain-preserved'] = shared
    const result = await runErasure(deps({ erasers }))
    expect(runs).toBe(1)
    expect(result.stores.filter((s) => s.store.startsWith('brain')).every((s) => s.outcome === 'erased')).toBe(true)
  })

  it('missing eraser is failed', async () => {
    const erasers = allErasers()
    delete erasers.voiceprints
    const result = await runErasure(deps({ erasers }))
    expect(result.stores.find((s) => s.store === 'voiceprints')?.outcome).toBe('failed')
    expect(result.exceptions).toContainEqual({ store: 'voiceprints', code: 'no-eraser' })
  })

  it('verify turns still-present into failed', async () => {
    const erasers = allErasers()
    erasers.meetings = { erase: async () => ({ outcome: 'erased', count: 3 }), present: async () => true }
    const result = await runErasure(deps({ erasers }))
    expect(result.stores.find((s) => s.store === 'meetings')?.outcome).toBe('failed')
    expect(result.exceptions).toContainEqual({ store: 'meetings', code: 'still-present' })
  })

  it('names retained and external exceptions', async () => {
    const result = await runErasure(deps())
    expect(result.stores.find((s) => s.store === 'audit-log')?.outcome).toBe('retained')
    expect(result.stores.find((s) => s.store === 'operator-records')?.outcome).toBe('external-pending')
    expect(result.exceptions).toContainEqual({ store: 'operator-records', code: 'operator-endpoint-missing' })
    expect(result.exceptions).toContainEqual({ store: 'cloud-sync-copies', code: 'cloud-sync-recycle-bin' })
  })

  it('a fence that cannot be written erases nothing', async () => {
    const log: string[] = []
    const result = await runErasure(deps({ erasers: allErasers(log), writeFence: async () => false }))
    expect(log).toEqual([])
    expect(result.failed).toBeGreaterThan(0)
    expect(result.exceptions).toContainEqual({ store: 'identity', code: 'fence-write-failed' })
  })

  it('receipt and audit carry no path, email or error text', async () => {
    const erasers = allErasers()
    erasers.assistants = {
      erase: async () => {
        throw new Error('/Users/someone/secret.bin a@b.com')
      }
    }
    erasers.meetings = ok(4)
    const d = deps({ erasers })
    const result = await runErasure(d)
    const text = JSON.stringify([result, d.audits])
    expect(text).not.toMatch(/\/Users|a@b\.com|secret/)
    expect(d.audits.length).toBe(1)
  })
})
