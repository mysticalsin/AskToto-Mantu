import { describe, expect, it } from 'vitest'
import { DATA_STORES, DATA_STORE_IDS, dataStoresFor, erasablePhase } from './data-store-inventory'

describe('data store inventory (G82)', () => {
  it('ids unique', () => {
    expect(new Set(DATA_STORE_IDS).size).toBe(DATA_STORES.length)
  })

  it('delete rows have a phase', () => {
    for (const entry of dataStoresFor('delete')) expect([1, 2, 3, 4, 5]).toContain(entry.phase)
    for (const entry of [...dataStoresFor('retain'), ...dataStoresFor('external')]) expect(entry.phase).toBeUndefined()
  })

  it('retain/external rows carry a reason', () => {
    for (const entry of [...dataStoresFor('retain'), ...dataStoresFor('external')]) {
      expect(entry.reason).toMatch(/^[a-z0-9-]{3,64}$/)
    }
  })

  it('exposes dataClass/location/encryptedAtRest for G83', () => {
    for (const entry of DATA_STORES) {
      expect(entry.label.length).toBeGreaterThan(2)
      expect(entry.dataClass).toBeTruthy()
      expect(entry.location).toBeTruthy()
      expect(['always', 'setting', 'never']).toContain(entry.encryptedAtRest)
      expect(entry.scope).toBeTruthy()
    }
  })

  it('every phase has at least one store and quiesce rows are outboxes', () => {
    for (const phase of [1, 2, 3, 4, 5] as const) expect(erasablePhase(phase).length).toBeGreaterThan(0)
    expect(erasablePhase(1).every((e) => e.dataClass === 'outbox')).toBe(true)
  })
})
