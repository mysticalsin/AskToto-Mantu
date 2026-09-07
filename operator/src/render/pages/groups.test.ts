import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderGroups } from './groups'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderGroups (QA fixture)', () => {
  it('renders the named empty state (P1.8 has not landed a real Groups page yet)', async () => {
    const data = await fixtureDashboard()
    const html = renderGroups(data, CTX)
    expect(html).toContain('No groups yet.')
    expect(html).toContain('A group gives a team a tier and its own licenses.')
    expect(html).toContain('>Groups<')
    expect(html).not.toContain('style="')
  })
})
