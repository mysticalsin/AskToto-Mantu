import { describe, it, expect } from 'vitest'
import { isDustReady, dustStoredAgentMissing, applyInteractiveGuardrail, parseDustUrl, detectProvider, filterAllowedProviders, migrateRetiredModelId, migrateRetiredModelMap, reasoningEffortFor, resolveModelTier, PROVIDERS, dustAgentVision } from './providers'

// MQA-001 (docs/qa/BUG-LEDGER.md): the registry shipped DeepSeek's retired 'deepseek-chat' /
// 'deepseek-reasoner' ids as its defaults after their 2026-07-24 discontinuation date. If these tests
// fail, read that ledger entry before "fixing" them — the ids must stay on the V4 generation.
describe('DeepSeek V4 registry (MQA-001)', () => {
  it('offers only V4 ids — the retired chat/reasoner ids are never suggested', () => {
    // DeepSeek announced 'deepseek-chat'/'deepseek-reasoner' for discontinuation on 2026-07-24. Shipping
    // them as suggestions hands users an id that stops answering with no change on our side.
    expect(PROVIDERS.deepseek.models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
    expect(PROVIDERS.deepseek.models).not.toContain('deepseek-chat')
    expect(PROVIDERS.deepseek.models).not.toContain('deepseek-reasoner')
  })

  it('resolves V4 Flash for the base tier and V4 Pro for think/deep with no user override', () => {
    expect(resolveModelTier('deepseek', {}, {}, 'base')).toBe('deepseek-v4-flash')
    expect(resolveModelTier('deepseek', {}, {}, 'think')).toBe('deepseek-v4-pro')
    expect(resolveModelTier('deepseek', {}, {}, 'deep', {})).toBe('deepseek-v4-pro')
  })
})

describe('migrateRetiredModelId — provider-retired ids heal on read (MQA-001)', () => {
  it('maps both retired DeepSeek ids to V4 Flash, never to the 3x-pricier Pro', () => {
    // DeepSeek documents chat/reasoner as aliases for V4-Flash's non-thinking/thinking modes, so Flash is
    // the faithful successor for both; silently promoting a user to Pro would triple their token cost.
    expect(migrateRetiredModelId('deepseek', 'deepseek-chat')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('deepseek', 'deepseek-reasoner')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('openrouter', 'deepseek/deepseek-chat')).toBe('deepseek/deepseek-v4-flash')
  })

  it('passes through live ids, custom fine-tunes, other providers, and blanks untouched', () => {
    expect(migrateRetiredModelId('deepseek', 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(migrateRetiredModelId('deepseek', 'my-org/deepseek-chat-ft-2026')).toBe('my-org/deepseek-chat-ft-2026')
    expect(migrateRetiredModelId('openai', 'deepseek-chat')).toBe('deepseek-chat') // not deepseek's map
    expect(migrateRetiredModelId('deepseek', '')).toBe('')
  })

  it('migrates a whole persisted map and returns the SAME object when nothing changed', () => {
    const stale = { deepseek: 'deepseek-chat', anthropic: 'claude-opus-4-8' }
    expect(migrateRetiredModelMap(stale)).toEqual({ deepseek: 'deepseek-v4-flash', anthropic: 'claude-opus-4-8' })
    const clean = { deepseek: 'deepseek-v4-flash' }
    expect(migrateRetiredModelMap(clean)).toBe(clean) // identity → callers can skip a settings rewrite
  })
})

describe('reasoningEffortFor', () => {
  it('keeps DeepSeek V4 off its default thinking mode at the base tier (live suggest has a 15s budget)', () => {
    expect(reasoningEffortFor('deepseek', 'base', false)).toBe('low')
    expect(reasoningEffortFor('deepseek', 'think', false)).toBe('high')
    expect(reasoningEffortFor('deepseek', 'deep', false)).toBe('high')
    expect(reasoningEffortFor('deepseek', 'base', true)).toBe('high') // user turned Métis thinking on
  })

  it('preserves the original tier-independent Kimi behavior exactly', () => {
    expect(reasoningEffortFor('kimi', 'base', false)).toBe('low')
    expect(reasoningEffortFor('kimi', 'deep', false)).toBe('low')
    expect(reasoningEffortFor('kimi', 'base', true)).toBe('high')
  })

  it('is undefined for every other provider so their request bodies stay byte-identical', () => {
    for (const id of ['anthropic', 'openai', 'nvidia', 'dust', 'local', 'claude-cli', 'grok'] as const) {
      expect(reasoningEffortFor(id, 'base', false)).toBeUndefined()
      expect(reasoningEffortFor(id, 'deep', true)).toBeUndefined()
    }
  })
})

describe('dustAgentVision', () => {
  it('treats every Claude (anthropic) agent as vision-capable', () => {
    expect(dustAgentVision({ modelProviderId: 'anthropic', modelId: 'claude-3-5-sonnet-20241022' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'anthropic', modelId: 'claude-sonnet-4-20250514' })).toBe(true)
  })

  it('treats modern multimodal OpenAI models as vision, legacy text ones as not', () => {
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-4o' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-4.1' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'o3' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'openai', modelId: 'gpt-3.5-turbo' })).toBe(false)
  })

  it('treats Gemini as vision and honors explicit vl/vision/pixtral hints', () => {
    expect(dustAgentVision({ modelProviderId: 'google_ai_studio', modelId: 'gemini-1.5-pro' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'mistral', modelId: 'pixtral-large' })).toBe(true)
    expect(dustAgentVision({ modelProviderId: 'fireworks', modelId: 'qwen-vl-max' })).toBe(true)
  })

  it('is false for text-only providers/models and missing input', () => {
    expect(dustAgentVision({ modelProviderId: 'mistral', modelId: 'mistral-large' })).toBe(false)
    expect(dustAgentVision({ modelProviderId: 'deepseek', modelId: 'deepseek-chat' })).toBe(false)
    expect(dustAgentVision(null)).toBe(false)
    expect(dustAgentVision({})).toBe(false)
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

describe('dustStoredAgentMissing', () => {
  const agents = [{ sId: 'a1' }, { sId: 'a2' }]

  it('true when the stored agent is absent from a loaded, non-empty workspace list', () => {
    expect(dustStoredAgentMissing('gone', agents)).toBe(true)
  })

  it('false when the stored agent is present in the workspace', () => {
    expect(dustStoredAgentMissing('a1', agents)).toBe(false)
  })

  it('false when no agent is selected', () => {
    expect(dustStoredAgentMissing('', agents)).toBe(false)
  })

  it('false before the list has loaded (null) — no false alarm', () => {
    expect(dustStoredAgentMissing('gone', null)).toBe(false)
  })

  it('false for an empty list (restricted/failed load is not proof the agent is gone)', () => {
    expect(dustStoredAgentMissing('gone', [])).toBe(false)
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

describe('parseDustUrl agent-id extraction (only unambiguous agent sources)', () => {
  it('extracts the agent from builder URLs and query params', () => {
    expect(parseDustUrl('https://dust.tt/w/abc123/builder/agents/vJxYHvTRBT').agentId).toBe('vJxYHvTRBT')
    expect(parseDustUrl('https://eu.dust.tt/w/abc123/builder/assistants/GOr913Zr5V').agentId).toBe('GOr913Zr5V')
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/CONV42?assistant=vJxYHvTRBT').agentId).toBe('vJxYHvTRBT')
  })

  it('never mistakes a conversation id for an agent id', () => {
    // A bare /assistant/<id> path is a CONVERSATION on dust.tt — treating it as an agent silently
    // pointed the base agent at garbage when a user pasted a chat link (2026-07-06 review finding).
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/8CzUOZaanQ').agentId).toBeUndefined()
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/new').agentId).toBeUndefined()
    // Workspace/region auto-fill still works on those links.
    expect(parseDustUrl('https://dust.tt/w/abc123/assistant/8CzUOZaanQ').workspaceId).toBe('abc123')
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
