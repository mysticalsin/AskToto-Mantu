import type { OrbState } from 'thinking-orbs'

/**
 * Product wait kinds → luxury caption + thinking-orbs state.
 * Source of truth: docs/design/THINKING-ORB.md
 */
export const AGENT_STATUS = {
  thinking: { caption: 'Thinking', state: 'solving' },
  working: { caption: 'Thinking', state: 'working' },
  listening: { caption: 'Listening', state: 'listening' },
  writing: { caption: 'Writing', state: 'composing' },
  searching: { caption: 'Searching', state: 'searching' },
  connecting: { caption: 'Connecting', state: 'connecting' },
  'loading-model': { caption: 'Loading', state: 'weaving' },
  loading: { caption: 'Loading', state: 'breathing' },
  planning: { caption: 'Planning', state: 'shaping' }
} as const satisfies Record<string, { caption: string; state: OrbState }>

export type AgentStatusKind = keyof typeof AGENT_STATUS

export function agentStatusFor(kind: AgentStatusKind): { caption: string; state: OrbState } {
  return AGENT_STATUS[kind]
}
