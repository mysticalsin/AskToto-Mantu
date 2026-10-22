import { describe, expect, it } from 'vitest'
import { createLatestGate } from './latest-request'

describe('createLatestGate', () => {
  it("only the most recent request's result is applied", () => {
    const gate = createLatestGate()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isLatest(first)).toBe(false)
    expect(gate.isLatest(second)).toBe(true)
  })

  it('a request is the latest until the next one begins', () => {
    const gate = createLatestGate()
    const only = gate.begin()
    expect(gate.isLatest(only)).toBe(true)
    expect(gate.isLatest(only)).toBe(true)
    gate.begin()
    expect(gate.isLatest(only)).toBe(false)
  })

  it('cancel drops the request in flight without starting another', () => {
    const gate = createLatestGate()
    const pending = gate.begin()
    gate.cancel()
    expect(gate.isLatest(pending)).toBe(false)
  })

  it('gates are independent', () => {
    const a = createLatestGate()
    const b = createLatestGate()
    const fromA = a.begin()
    b.begin()
    expect(a.isLatest(fromA)).toBe(true)
  })
})
