import { describe, expect, it } from 'vitest'
import type { ChatTurn } from '@shared/ipc'
import { readModuleSource } from '../../../test-helpers/module-source'
import { forgetStaleTurns, rememberTurn } from './stale-outputs'

const pair = (id: string, q: string, a: string): ChatTurn[] => {
  const user: ChatTurn = { role: 'user', content: q }
  rememberTurn(user, id)
  return [user, { role: 'assistant', content: a }]
}

describe('forgetStaleTurns', () => {
  it('drops the question and the answer of each stale output and keeps the others in order', () => {
    const turns = [...pair('a', 'q1', 'a1'), ...pair('b', 'q2', 'a2'), ...pair('c', 'q3', 'a3')]
    const kept = forgetStaleTurns(turns, new Set(['a', 'c']))
    expect(kept.map((turn) => turn.content)).toEqual(['q2', 'a2'])
  })

  it('keeps every turn when none is stale, and returns the same array so nothing re-renders', () => {
    const turns = [...pair('a', 'q1', 'a1')]
    expect(forgetStaleTurns(turns, new Set(['zzz']))).toBe(turns)
    expect(forgetStaleTurns(turns, new Set())).toBe(turns)
  })

  it('never drops a turn it did not record (history seeded by other paths stays)', () => {
    const seeded: ChatTurn[] = [
      { role: 'user', content: 'seeded question' },
      { role: 'assistant', content: 'seeded answer' }
    ]
    expect(forgetStaleTurns(seeded, new Set(['a']))).toBe(seeded)
  })

  it('follows the question object, so a copy of the array (slice, reset) keeps its identity', () => {
    const turns = [...pair('a', 'q1', 'a1'), ...pair('b', 'q2', 'a2')]
    expect(forgetStaleTurns(turns.slice(-4), new Set(['b'])).map((turn) => turn.content)).toEqual(['q1', 'a1'])
  })
})

describe('useConversationMemory is the renderer consumer of a stale output report', () => {
  const source = readModuleSource(__dirname, './conversation-memory').text
  it('subscribes to the bridge, forgets the stale turns and dismisses only a stale ambient suggestion', () => {
    expect(source).toMatch(/window\.toto\.onSessionOutputsStale\(/)
    expect(source).toMatch(/forgetStaleTurns\(/)
    expect(source).toMatch(/ephemeral/)
    expect(source).toMatch(/latest\.current\.clear\(\)/)
  })
})
