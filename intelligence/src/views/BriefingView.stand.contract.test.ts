import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

describe('Cap3 Briefing stand contract', () => {
  const src = readFileSync(new URL('./BriefingView.tsx', import.meta.url), 'utf8')
  it('defines StandSection with data-metis-stand', () => {
    expect(src).toContain('function StandSection')
    expect(src).toContain('data-metis-stand="1"')
  })
  it('renders StandSection on empty-brain path (not EmptyState-only)', () => {
    expect(src).toContain('brainLooksEmpty')
    const emptyIdx = src.indexOf('if (brainLooksEmpty)')
    const emptyBlock = src.slice(emptyIdx, emptyIdx + 900)
    expect(emptyBlock).toContain('<StandSection')
    expect(emptyBlock).toContain('<EmptyState')
  })
  it('renders StandSection on populated Today path', () => {
    expect(src).toMatch(/<StandSection data=\{data\} now=\{now\} \/>/)
  })
})
