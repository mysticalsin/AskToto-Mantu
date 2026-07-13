import { describe, it, expect } from 'vitest'
import { isDustReady, dustStoredAgentMissing, applyInteractiveGuardrail, parseDustUrl, PROVIDERS, dustAgentVision } from './providers'

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
