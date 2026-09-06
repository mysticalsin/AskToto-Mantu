import { describe, expect, it } from 'vitest'
import { buildSystemParts } from './personas'
import type { AskStart, Profile } from '@shared/ipc'

const EMPTY_PROFILE: Profile = { name: '', role: '', company: '', resume: '', jobDescription: '', notes: '' }

function ask(overrides: Partial<AskStart> = {}): AskStart {
  return { id: 'x', mode: 'answer', prompt: 'hello', history: [], ...overrides } as AskStart
}

describe('buildSystemParts prefix stability', () => {
  it('two calls in one session with different transcripts share identical cached-prefix bytes', () => {
    const a = buildSystemParts(
      ask({ transcript: 'THEM: first take\nYOU: thanks' }),
      'interview',
      EMPTY_PROFILE,
      {},
      []
    )
    const b = buildSystemParts(
      ask({ transcript: 'THEM: a later turn about budget and visas' }),
      'interview',
      EMPTY_PROFILE,
      {},
      []
    )
    expect(a.cachedPrefix).toBe(b.cachedPrefix)
    expect(a.cachedPrefix).not.toMatch(/first take|later turn|budget and visas/)
    expect(a.cachedPrefix).not.toMatch(/Date\.now|Math\.random/)
  })

  it('does not leak the typed question or a clock into the cached prefix', () => {
    const parts = buildSystemParts(
      ask({ prompt: 'UNIQUE_QUESTION_TOKEN_9f3a', id: `ask-${Date.now()}` }),
      'general',
      EMPTY_PROFILE,
      {},
      []
    )
    expect(parts.cachedPrefix).not.toContain('UNIQUE_QUESTION_TOKEN_9f3a')
    expect(parts.volatile).toBe('')
  })

  it('different history does not change the cached prefix', () => {
    const a = buildSystemParts(ask({ history: [] }), 'sales', EMPTY_PROFILE, {}, [])
    const b = buildSystemParts(
      ask({ history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }] }),
      'sales',
      EMPTY_PROFILE,
      {},
      []
    )
    expect(a.cachedPrefix).toBe(b.cachedPrefix)
    expect(a.cachedPrefix).not.toContain('earlier question')
  })
})
