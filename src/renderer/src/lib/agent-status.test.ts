import { describe, expect, it } from 'vitest'
import { AGENT_STATUS, agentStatusFor, type AgentStatusKind } from './agent-status'

const EXPECTED: Record<AgentStatusKind, { caption: string; state: string }> = {
  thinking: { caption: 'Thinking', state: 'solving' },
  working: { caption: 'Thinking', state: 'working' },
  listening: { caption: 'Listening', state: 'listening' },
  writing: { caption: 'Writing', state: 'composing' },
  searching: { caption: 'Searching', state: 'searching' },
  connecting: { caption: 'Connecting', state: 'connecting' },
  'loading-model': { caption: 'Loading', state: 'weaving' },
  loading: { caption: 'Loading', state: 'breathing' },
  planning: { caption: 'Planning', state: 'shaping' }
}

describe('agentStatusFor (THINKING-ORB contract)', () => {
  it('maps every product kind to the contracted caption and orb state', () => {
    for (const kind of Object.keys(EXPECTED) as AgentStatusKind[]) {
      expect(agentStatusFor(kind)).toEqual(EXPECTED[kind])
      expect(AGENT_STATUS[kind]).toEqual(EXPECTED[kind])
    }
  })

  it('does not invent extra kinds or leftover spinner words', () => {
    const captions = Object.values(AGENT_STATUS).map((s) => s.caption)
    expect(captions).not.toContain('Still working…')
    expect(captions).not.toContain('Generating…')
    expect(captions).not.toContain('Processing…')
    expect(captions).not.toContain('Starting Métis…')
    expect(Object.keys(AGENT_STATUS)).toHaveLength(9)
  })
})
