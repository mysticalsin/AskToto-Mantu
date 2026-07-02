import { describe, it, expect } from 'vitest'
import { routeTier, isHardQuestion, isHeavyQuestion } from './routing'
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

describe('isHeavyQuestion', () => {
  it('flags analytical / drafting / multi-sentence prompts (mid tier)', () => {
    expect(isHeavyQuestion('explain the tradeoffs between microservices and monoliths')).toBe(true)
    expect(isHeavyQuestion('compare these two vendors and recommend one')).toBe(true)
    expect(isHeavyQuestion('draft a thank-you note to the team')).toBe(true)
    expect(isHeavyQuestion('why did our churn go up last quarter')).toBe(true)
  })

  it('does not flag trivial one-liners', () => {
    expect(isHeavyQuestion('what is the capital of France')).toBe(false)
    expect(isHeavyQuestion('what time is it in Tokyo?')).toBe(false)
    expect(isHeavyQuestion('')).toBe(false)
  })
})

describe('routeTier', () => {
  it('live suggestions always use the base tier (must be instant)', () => {
    expect(routeTier({ mode: 'suggest', prompt: 'optimize this algorithm' }, 'always')).toBe('base')
    expect(routeTier({ mode: 'suggest', prompt: 'refactor the parser' }, 'auto')).toBe('base')
  })

  it('always = deepest model, never = fastest, regardless of difficulty', () => {
    expect(routeTier({ mode: 'answer', prompt: 'hello' }, 'always')).toBe('deep')
    expect(routeTier({ mode: 'answer', prompt: 'refactor my whole codebase' }, 'never')).toBe('base')
  })

  it('auto: 3-way escalation — basic→base, heavier→think, coding/deep→deep', () => {
    expect(routeTier({ mode: 'answer', prompt: 'what is the capital of France' }, 'auto')).toBe('base')
    expect(routeTier({ mode: 'answer', prompt: 'explain the tradeoffs between microservices and monoliths' }, 'auto')).toBe('think')
    expect(routeTier({ mode: 'answer', prompt: 'implement quicksort in rust' }, 'auto')).toBe('deep')
  })

  it('auto: recap uses think, summary stays cheap', () => {
    expect(routeTier({ mode: 'recap' }, 'auto')).toBe('think')
    expect(routeTier({ mode: 'summary' }, 'auto')).toBe('base')
  })

  it('fact-checks route to the strongest model (verifier path), even on an easy-looking claim', () => {
    expect(routeTier({ mode: 'answer', kind: 'factcheck', prompt: 'the sky is blue' }, 'auto')).toBe('deep')
    expect(routeTier({ mode: 'vision', kind: 'factcheck', prompt: 'claims on screen' }, 'auto')).toBe('deep')
    // fast-only is a hard cost cap — it still wins over the verifier escalation.
    expect(routeTier({ mode: 'answer', kind: 'factcheck', prompt: 'the sky is blue' }, 'never')).toBe('base')
  })
})

describe('resolveModelTier', () => {
  it('Anthropic defaults: base=Haiku, think=Sonnet, deep=Opus', () => {
    expect(resolveModelTier('anthropic', {}, {}, 'base')).toMatch(/haiku/i)
    expect(resolveModelTier('anthropic', {}, {}, 'think')).toBe('claude-sonnet-4-6')
    expect(resolveModelTier('anthropic', {}, {}, 'deep')).toBe('claude-opus-4-8')
  })

  it('deep falls back to think when a provider has no distinct deep model', () => {
    // gemini has fast+think but no deepModel → deep degrades to the think model.
    expect(resolveModelTier('gemini', {}, {}, 'deep')).toBe(resolveModelTier('gemini', {}, {}, 'think'))
  })

  it('Dust uses agent sIds; think/deep fall back to the base agent when unset', () => {
    expect(resolveModelTier('dust', { dust: 'base-agent' }, {}, 'base')).toBe('base-agent')
    expect(resolveModelTier('dust', { dust: 'base-agent' }, {}, 'think')).toBe('base-agent')
    expect(resolveModelTier('dust', { dust: 'base-agent' }, {}, 'deep')).toBe('base-agent')
    expect(resolveModelTier('dust', { dust: 'base-agent' }, { dust: 'think-agent' }, 'think')).toBe(
      'think-agent'
    )
    expect(
      resolveModelTier('dust', { dust: 'base-agent' }, { dust: 'think-agent' }, 'deep', { dust: 'deep-agent' })
    ).toBe('deep-agent')
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
