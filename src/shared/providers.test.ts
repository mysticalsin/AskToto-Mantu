import { describe, it, expect } from 'vitest'
import { isDustReady } from './providers'

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
