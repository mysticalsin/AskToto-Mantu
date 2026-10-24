import { describe, expect, it } from 'vitest'
import { evaluateMeter, parseOperatorMeters, type OperatorMeter } from './operator-meters'

const row = {
  id: 'managed_tokens',
  label: 'Managed AI tokens',
  unit: 'tokens',
  limit: 50_000,
  used: 12_000,
  resetAt: 2_000,
  window: 'day'
}
const meter = (over: Partial<OperatorMeter> = {}): OperatorMeter => ({ ...(row as OperatorMeter), ...over })

describe('parseOperatorMeters', () => {
  it('parses unit, limit, used and resetAt', () => {
    expect(parseOperatorMeters([row])).toEqual([row])
  })
  it('drops a meter without a safe non-negative integer limit', () => {
    const bad = [
      { ...row, limit: -1 },
      { ...row, id: 'b', limit: 1.5 },
      { ...row, id: 'c', limit: '9' },
      { ...row, id: 'd', limit: undefined },
      { ...row, id: 'e', limit: Number.MAX_SAFE_INTEGER + 2 }
    ]
    expect(parseOperatorMeters(bad)).toEqual([])
  })
  it('keeps used null as null', () => {
    expect(parseOperatorMeters([{ ...row, used: null }])[0].used).toBeNull()
    expect(parseOperatorMeters([{ ...row, used: -3 }])[0].used).toBeNull()
  })
  it('non-array parses to []', () => {
    expect(parseOperatorMeters(null)).toEqual([])
    expect(parseOperatorMeters({ 0: row })).toEqual([])
  })
  it('drops rows with a bad unit, id or label', () => {
    expect(
      parseOperatorMeters([
        { ...row, unit: 'usd' },
        { ...row, id: '' },
        { ...row, label: ' ' }
      ])
    ).toEqual([])
  })
  it('dedupes by id and caps at 16', () => {
    const twice = parseOperatorMeters([row, { ...row, limit: 1 }])
    expect(twice).toHaveLength(1)
    expect(twice[0].limit).toBe(50_000)
    const many = Array.from({ length: 30 }, (_, i) => ({ ...row, id: `m${i}` }))
    expect(parseOperatorMeters(many)).toHaveLength(16)
  })
})

describe('evaluateMeter', () => {
  it('available below limit with remaining', () => {
    expect(evaluateMeter(meter(), 1_000)).toEqual({ state: 'available', remaining: 38_000 })
  })
  it('exhausted when used reaches limit', () => {
    expect(evaluateMeter(meter({ used: 50_000 }), 1_000)).toEqual({ state: 'exhausted', remaining: 0 })
  })
  it('unknown when used is null', () => {
    expect(evaluateMeter(meter({ used: null }), 1_000)).toEqual({ state: 'unknown', remaining: null })
  })
  it('unknown, not exhausted, once resetAt has passed', () => {
    expect(evaluateMeter(meter({ used: 50_000, resetAt: 2_000 }), 2_000)).toEqual({ state: 'unknown', remaining: null })
  })
})
