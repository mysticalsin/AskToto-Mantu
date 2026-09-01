import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asStatusBadgeState, STATUS_BADGE_LABEL, STATUS_BADGE_STATES, statusBadge } from './status-badge'

describe('StatusBadge', () => {
  it('maps all seven states with the Submitted spelling', () => {
    expect(STATUS_BADGE_STATES).toEqual([
      'pending',
      'in_progress',
      'in_review',
      'submitted',
      'success',
      'failed',
      'expired'
    ])
    expect(STATUS_BADGE_LABEL.submitted).toBe('Submitted')
    expect(JSON.stringify(STATUS_BADGE_LABEL)).not.toContain('Submited')
    for (const state of STATUS_BADGE_STATES) {
      const html = statusBadge(state)
      expect(html).toContain(`data-status="${state}"`)
      expect(html).toContain(STATUS_BADGE_LABEL[state])
      expect(html).toContain('<svg')
      expect(html).not.toContain('bg-orange-50')
      expect(html).not.toContain('unsplash')
    }
  })

  it('accepts hyphen aliases and dead-letter as expired', () => {
    expect(asStatusBadgeState('in-progress')).toBe('in_progress')
    expect(asStatusBadgeState('in-review')).toBe('in_review')
    expect(asStatusBadgeState('dead-letter')).toBe('expired')
    expect(asStatusBadgeState('Submited')).toBeNull()
    expect(statusBadge('nope')).toBe('')
  })

  it('does not ship a StatusDemo grid page or repo-root pastel dump', () => {
    const root = join(process.cwd(), '..')
    expect(existsSync(join(root, 'components/ui/status-demo.tsx'))).toBe(false)
    expect(existsSync(join(root, 'components/ui/StatusDemo.tsx'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'src/components/ui/status-demo.tsx'))).toBe(false)
  })
})
