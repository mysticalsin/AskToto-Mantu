import { describe, expect, it } from 'vitest'
import { outputTokenBudget } from './openai'

describe('OpenAI-compatible completion budget', () => {
  it('honors an explicit provider-strategy override', () => {
    expect(outputTokenBudget('qwen3.5-0.8b', 'summary', 512)).toBe(512)
    expect(outputTokenBudget('qwen3.5-0.8b', 'suggest', 96)).toBe(96)
    expect(outputTokenBudget('qwen3.5-0.8b', 'vision', 384)).toBe(384)
  })

  it('does not weaken existing cloud defaults when no override is supplied', () => {
    expect(outputTokenBudget('gpt-5-mini', 'summary')).toBe(4096)
    expect(outputTokenBudget('gpt-5-mini', 'recap')).toBe(8192)
    expect(outputTokenBudget('o3', 'answer')).toBe(8192)
  })
})
