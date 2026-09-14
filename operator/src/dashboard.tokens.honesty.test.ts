import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('dashboard askTokenTotal F10', () => {
  const src = readFileSync(resolve(__dirname, 'dashboard.ts'), 'utf8')
  it('counts input_tokens in askTokenTotal', () => {
    expect(src).toMatch(/input_tokens\?: number \| null/)
    expect(src).toMatch(/return \(a\.input_tokens \?\? 0\) \+ \(a\.output_tokens \?\? 0\)/)
  })
  it('costForAsks falls back to estimateListPrice', () => {
    expect(src).toMatch(/estimateListPrice\(a\.model/)
  })
})
