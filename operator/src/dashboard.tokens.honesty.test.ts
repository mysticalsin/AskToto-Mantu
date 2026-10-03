import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const dashboardProjectionSrc = ['dashboard.ts', 'dashboard/shared.ts', 'dashboard/cost.ts']
  .map((file) => readFileSync(resolve(__dirname, file), 'utf8'))
  .join('\n')

describe('dashboard askTokenTotal F10', () => {
  const src = dashboardProjectionSrc
  it('counts input_tokens in askTokenTotal', () => {
    expect(src).toMatch(/input_tokens\?: number \| null/)
    expect(src).toMatch(/return \(a\.input_tokens \?\? 0\) \+ \(a\.output_tokens \?\? 0\)/)
  })
  it('costForAsks falls back to estimateListPrice', () => {
    expect(src).toMatch(/estimateListPrice\(a\.model/)
  })
})

describe('portalPathSpend honesty (#182 / #112)', () => {
  const src = dashboardProjectionSrc
  it('never concatenates tok · not reported', () => {
    expect(src).not.toMatch(/\$\{tok\} · not reported/)
    expect(src).toMatch(/matchesPortalPath/)
    expect(src).toMatch(/parts\.join\(' · '\)/)
  })
  it('sums askTokenTotal for portal path tokens', () => {
    expect(src).toMatch(/const t = askTokenTotal\(a\)/)
  })
})
