import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('overview-cards COST_METERING honesty', () => {
  const src = readFileSync(resolve(__dirname, 'overview-cards.ts'), 'utf8')

  it('reported(null) must not invent 0', () => {
    expect(src).toMatch(/if \(value == null\) return 'not reported'/)
    expect(src).not.toMatch(/if \(value == null\) return '0'/)
  })

  it('missing cost7d must not invent $0', () => {
    expect(src).toMatch(/cost7d \?\? 'not reported'/)
    expect(src).not.toMatch(/cost7d \?\? '0'/)
  })

  it('surfaces usage completeness chip (missing tokens stay not reported)', () => {
    expect(src).toMatch(/Usage completeness/)
    expect(src).toMatch(/asksWithTokens/)
    expect(src).toMatch(/asksMissingTokens/)
  })
})
