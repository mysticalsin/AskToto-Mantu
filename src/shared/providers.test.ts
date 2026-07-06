import { describe, it, expect } from 'vitest'
import { isDustReady, applyInteractiveGuardrail, parseDustUrl, PROVIDERS } from './providers'

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
