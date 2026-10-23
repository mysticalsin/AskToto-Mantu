import { describe, expect, it } from 'vitest'
import type { UserMemoryItem } from '@shared/user-memory'
import { userMemoryDetail } from './user-memory-view'

const DAY = 86_400_000
const base: UserMemoryItem = {
  id: 'a'.repeat(32),
  kind: 'preference',
  text: 'x',
  source: 'owner-typed',
  at: 0,
  revision: 1,
  expiresAt: null,
  conversation: null
}

describe('user memory rows', () => {
  it('a preference says it is kept until removed', () => {
    expect(userMemoryDetail(base, 0)).toBe('You typed this. Kept until you remove it.')
    expect(userMemoryDetail({ ...base, source: 'owner-spoken' }, 0)).toContain('You said this')
    expect(userMemoryDetail({ ...base, source: 'settings' }, 0)).toContain('Set in Settings')
  })
  it('project context says where it came from and when it is forgotten', () => {
    const item: UserMemoryItem = {
      ...base,
      kind: 'project-context',
      source: 'derived',
      expiresAt: 30 * DAY,
      conversation: 'meeting 7'
    }
    expect(userMemoryDetail(item, 0)).toBe(
      'Noticed in your work. From meeting 7. Forgotten in 30 days unless used again.'
    )
    expect(userMemoryDetail({ ...item, expiresAt: 29 * DAY + 1 }, 0)).toContain('in 30 days')
    expect(userMemoryDetail({ ...item, expiresAt: DAY }, 0)).toContain('in 1 day unless')
  })
})
