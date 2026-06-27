import { describe, it, expect } from 'vitest'
import { routeTier, isHardQuestion } from './routing'
import { resolveModelTier } from './providers'

describe('isHardQuestion', () => {
  it('flags coding / engineering / complex prompts', () => {
    expect(isHardQuestion('write a function to reverse a linked list')).toBe(true)
    expect(isHardQuestion('help me debug this stack trace')).toBe(true)
    expect(isHardQuestion('design the database schema for multi-tenant')).toBe(true)
    expect(isHardQuestion('optimize the SQL query performance')).toBe(true)
    expect(isHardQuestion('```ts\nconst x = 1\n```')).toBe(true) // code fence
    expect(isHardQuestion('prove this theorem by induction')).toBe(true)
    expect(isHardQuestion('think step by step about this')).toBe(true)
  })

  it('treats casual prompts as easy', () => {
    expect(isHardQuestion('what time is it in Tokyo?')).toBe(false)
    expect(isHardQuestion('draft a thank-you note to the team')).toBe(false)
    expect(isHardQuestion('what is the capital of France')).toBe(false)
    expect(isHardQuestion('')).toBe(false)
  })
})

describe('routeTier', () => {
  it('live suggestions always use the base tier (must be instant)', () => {
    expect(routeTier({ mode: 'suggest', prompt: 'optimize this algorithm' }, 'always')).toBe('base')
    expect(routeTier({ mode: 'suggest', prompt: 'refactor the parser' }, 'auto')).toBe('base')
  })

  it('always / never policies override difficulty', () => {
    expect(routeTier({ mode: 'answer', prompt: 'hello' }, 'always')).toBe('think')
    expect(routeTier({ mode: 'answer', prompt: 'refactor my whole codebase' }, 'never')).toBe('base')
  })

  it('auto escalates hard questions, keeps easy ones cheap', () => {
    expect(routeTier({ mode: 'answer', prompt: 'implement quicksort in rust' }, 'auto')).toBe('think')
    expect(routeTier({ mode: 'answer', prompt: 'what is the capital of France' }, 'auto')).toBe('base')
  })

  it('auto: recap goes deep, summary stays cheap', () => {
    expect(routeTier({ mode: 'recap' }, 'auto')).toBe('think')
    expect(routeTier({ mode: 'summary' }, 'auto')).toBe('base')
  })
})

describe('resolveModelTier', () => {
  it('Anthropic defaults: base=Haiku, think=Sonnet', () => {
    expect(resolveModelTier('anthropic', {}, {}, 'base')).toMatch(/haiku/i)
    expect(resolveModelTier('anthropic', {}, {}, 'think')).toBe('claude-sonnet-4-6')
  })

  it('Dust uses agent sIds; think falls back to the base agent when unset', () => {
    expect(resolveModelTier('dust', { dust: 'base-agent' }, {}, 'base')).toBe('base-agent')
    expect(resolveModelTier('dust', { dust: 'base-agent' }, {}, 'think')).toBe('base-agent')
    expect(resolveModelTier('dust', { dust: 'base-agent' }, { dust: 'think-agent' }, 'think')).toBe(
      'think-agent'
    )
  })

  it('user overrides win over provider defaults', () => {
    expect(resolveModelTier('anthropic', { anthropic: 'claude-opus-4-8' }, {}, 'base')).toBe(
      'claude-opus-4-8'
    )
    expect(
      resolveModelTier('deepseek', {}, { deepseek: 'deepseek-chat' }, 'think')
    ).toBe('deepseek-chat')
  })
})
