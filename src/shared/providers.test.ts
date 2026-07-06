import { describe, it, expect } from 'vitest'
import { isDustReady, applyInteractiveGuardrail, detectProvider, filterAllowedProviders, PROVIDERS } from './providers'

describe('filterAllowedProviders — org data-residency allowlist', () => {
  it('returns ids unchanged when the allowlist is null/undefined (unrestricted)', () => {
    expect(filterAllowedProviders(['anthropic', 'openai', 'grok'], null)).toEqual(['anthropic', 'openai', 'grok'])
    expect(filterAllowedProviders(['anthropic', 'openai'], undefined)).toEqual(['anthropic', 'openai'])
  })

  it('keeps only ids present in the allowlist, preserving order', () => {
    expect(filterAllowedProviders(['anthropic', 'openai', 'grok', 'kimi'], ['grok', 'anthropic'])).toEqual([
      'anthropic',
      'grok'
    ])
  })

  it('returns empty when the allowlist excludes every candidate', () => {
    expect(filterAllowedProviders(['anthropic', 'openai'], ['dust'])).toEqual([])
    expect(filterAllowedProviders(['anthropic', 'openai'], [])).toEqual([])
  })
})

describe('isDustReady', () => {
  it('is true only when the key, workspace, and base agent are all present', () => {
    expect(isDustReady({ dust: true }, 'ws_123', { dust: 'agent_abc' })).toBe(true)
  })

  it('is false when the Dust API key is missing, even with workspace + agent set', () => {
    expect(isDustReady({}, 'ws_123', { dust: 'agent_abc' })).toBe(false)
    expect(isDustReady({ dust: false }, 'ws_123', { dust: 'agent_abc' })).toBe(false)
  })

  it('is false when the workspace id is missing or blank', () => {
    expect(isDustReady({ dust: true }, '', { dust: 'agent_abc' })).toBe(false)
    expect(isDustReady({ dust: true }, '   ', { dust: 'agent_abc' })).toBe(false)
  })

  it('is false when no base agent is configured for dust', () => {
    expect(isDustReady({ dust: true }, 'ws_123', {})).toBe(false)
    expect(isDustReady({ dust: true }, 'ws_123', { dust: '' })).toBe(false)
  })

  it('is independent of other providers having keys — only dust matters', () => {
    expect(isDustReady({ dust: true, kimi: true, anthropic: true }, 'ws_123', { dust: 'agent_abc' })).toBe(true)
    expect(isDustReady({ kimi: true, anthropic: true }, 'ws_123', { dust: 'agent_abc' })).toBe(false)
  })
})

describe('applyInteractiveGuardrail', () => {
  it('locks claude-cli to Sonnet for every tier, ignoring the resolved model', () => {
    expect(applyInteractiveGuardrail('claude-cli', 'base', 'haiku')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'think', 'sonnet')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'deep', 'opus')).toBe('sonnet')
  })

  it('pins anthropic base tier to the Haiku id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'base', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.fastModel
    )
  })

  it('pins anthropic think tier to the Sonnet id regardless of the resolved model', () => {
    expect(applyInteractiveGuardrail('anthropic', 'think', 'claude-opus-4-8')).toBe(
      PROVIDERS.anthropic.thinkModel
    )
  })

  it('does NOT lock anthropic deep tier — Opus stays reachable for hard questions', () => {
    expect(applyInteractiveGuardrail('anthropic', 'deep', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('passes every other provider/tier combination through unchanged', () => {
    expect(applyInteractiveGuardrail('openai', 'base', 'gpt-4o-mini')).toBe('gpt-4o-mini')
    expect(applyInteractiveGuardrail('dust', 'think', 'agent_abc')).toBe('agent_abc')
    expect(applyInteractiveGuardrail('codex-cli', 'base', '')).toBe('')
  })
})

describe('detectProvider', () => {
  it('resolves an xai- key to grok (xAI)', () => {
    expect(detectProvider('xai-abc123DEF456ghi789')).toBe('grok')
  })

  it('resolves an sk-ant- key to anthropic, beating the generic sk- guess', () => {
    expect(detectProvider('sk-ant-abc123DEF456ghi789')).toBe('anthropic')
  })

  it('never guesses on an ambiguous bare sk- key shared by several providers', () => {
    expect(detectProvider('sk-abc123DEF456ghi789')).toBeNull()
  })

  it('returns null for an empty or blank key', () => {
    expect(detectProvider('')).toBeNull()
    expect(detectProvider('   ')).toBeNull()
  })
})
