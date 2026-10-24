import { describe, expect, it } from 'vitest'
import { dustConversationState, registerDustConversationState } from './dust-conversation-state'

describe('dust conversation state (G49)', () => {
  it('reports nothing held before a provider registers, then the registered state', () => {
    expect(dustConversationState()).toEqual({ epoch: 0, active: false, ttlMs: 0 })
    registerDustConversationState(() => ({ epoch: 4, active: true, ttlMs: 9 }))
    expect(dustConversationState()).toEqual({ epoch: 4, active: true, ttlMs: 9 })
  })
})
