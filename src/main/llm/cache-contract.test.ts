import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const anthropic = readFileSync(join(__dirname, 'anthropic.ts'), 'utf8')
const openai = readFileSync(join(__dirname, 'openai.ts'), 'utf8')

describe('Anthropic prompt-cache contract', () => {
  it('puts 1h ephemeral cache_control on the last stable system block', () => {
    expect(anthropic).toMatch(/ttl:\s*'1h'/)
    expect(anthropic).toMatch(/cache_control/)
    expect(anthropic).toMatch(/cachedPrefix/)
  })

  it('retries default ephemeral and records ttl 5m on a 400', () => {
    expect(anthropic).toMatch(/isTtlRejection/)
    expect(anthropic).toMatch(/start\('5m'\)/)
    expect(anthropic).toMatch(/mapAnthropicUsage\(m\.usage, usedTtl\)/)
  })
})

describe('OpenAI prompt-cache contract', () => {
  it('sends prompt_cache_key and an explicit breakpoint only when eligible', () => {
    expect(openai).toMatch(/prompt_cache_key/)
    expect(openai).toMatch(/prompt_cache_breakpoint/)
    expect(openai).toMatch(/prompt_cache_options/)
    expect(openai).toMatch(/isOpenAICloudCacheEligible/)
  })

  it('sets prompt_cache_key only inside the includePromptCache branch', () => {
    // A second, unconditional assignment used to survive every rung of the drop-on-400 ladder, so an
    // endpoint that rejects the unknown param (import recap sends the key to every provider) burned
    // three serial round trips and still failed.
    const assignments = openai.match(/params\.prompt_cache_key = opts\.promptCacheKey/g) ?? []
    expect(assignments).toHaveLength(1)
    expect(openai).toMatch(/if \(includePromptCache\) \{\n\s+if \(opts\.promptCacheKey\) params\.prompt_cache_key/)
  })

  it('on 400 strips cache fields once and marks the endpoint unsupported', () => {
    expect(openai).toMatch(/isPromptCacheRejection/)
    expect(openai).toMatch(/cacheUnsupported\.add/)
    expect(openai).toMatch(/wantCache && !dropCache/)
  })
})
