import { describe, expect, it, vi } from 'vitest'
import { createQuietOutputGate, evaluateQuietPolicy, type QuietPolicyInput } from './quiet-policy'

const input = (overrides: Partial<QuietPolicyInput> = {}): QuietPolicyInput => ({
  quietMode: 'calls-and-screen-sharing',
  inCall: false,
  screenShare: { available: false, state: 'unknown' },
  focus: { voice: 'unknown', text: 'unknown' },
  ...overrides
})

describe('G68 quiet output policy', () => {
  it('allows every channel when quiet mode and readable Focus are inactive', () => {
    expect(evaluateQuietPolicy(input())).toEqual({
      toast: 'allow',
      sound: 'allow',
      spokenReply: 'allow',
      proactiveSuggestion: 'allow',
      autoAnswerCard: 'allow'
    })
  })

  it('defers text and drops audio while a meeting or known screen share is active', () => {
    const expected = {
      toast: 'defer',
      sound: 'drop',
      spokenReply: 'drop',
      proactiveSuggestion: 'defer',
      autoAnswerCard: 'defer'
    }
    expect(evaluateQuietPolicy(input({ inCall: true }))).toEqual(expected)
    expect(evaluateQuietPolicy(input({ screenShare: { available: true, state: 'sharing' } }))).toEqual(expected)
  })

  it('lets Off override call and screen-share signals while Always quiets every channel', () => {
    const busy = input({ inCall: true, screenShare: { available: true, state: 'sharing' } })
    expect(evaluateQuietPolicy({ ...busy, quietMode: 'off' }).toast).toBe('allow')
    expect(evaluateQuietPolicy({ ...busy, quietMode: 'always' })).toEqual({
      toast: 'defer',
      sound: 'drop',
      spokenReply: 'drop',
      proactiveSuggestion: 'defer',
      autoAnswerCard: 'defer'
    })
  })

  it('assumes no screen share only when the platform has no signal, and treats an unreadable live signal as quiet', () => {
    expect(evaluateQuietPolicy(input({ screenShare: { available: false, state: 'unknown' } })).toast).toBe('allow')
    expect(evaluateQuietPolicy(input({ screenShare: { available: true, state: 'unknown' } })).toast).toBe('defer')
    expect(evaluateQuietPolicy(input({ screenShare: { available: true, state: 'not-sharing' } })).toast).toBe('allow')
  })

  it('uses separate text and voice Focus signals', () => {
    expect(evaluateQuietPolicy(input({ focus: { voice: 'active', text: 'inactive' } }))).toMatchObject({
      toast: 'allow',
      proactiveSuggestion: 'allow',
      autoAnswerCard: 'allow',
      sound: 'drop',
      spokenReply: 'drop'
    })
    expect(evaluateQuietPolicy(input({ focus: { voice: 'inactive', text: 'active' } }))).toMatchObject({
      toast: 'defer',
      proactiveSuggestion: 'defer',
      autoAnswerCard: 'defer',
      sound: 'allow',
      spokenReply: 'allow'
    })
  })

  it('assumes an unreadable OS Focus state is inactive', () => {
    expect(evaluateQuietPolicy(input({ focus: { voice: 'unknown', text: 'unknown' } })).toast).toBe('allow')
    expect(evaluateQuietPolicy(input({ focus: { voice: 'unknown', text: 'unknown' } })).sound).toBe('allow')
  })

  it('never suppresses a direct owner request', () => {
    const deliver = vi.fn()
    const gate = createQuietOutputGate({ now: () => 100, onReleased: vi.fn() })
    expect(gate.offer('spokenReply', input({ quietMode: 'always' }), true, deliver)).toBe('allow')
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('coalesces deferred channels and releases one batch when quiet ends', () => {
    let now = 100
    const onReleased = vi.fn()
    const gate = createQuietOutputGate({ now: () => now, onReleased })
    const quiet = input({ inCall: true })
    expect(gate.offer('toast', quiet, false, vi.fn())).toBe('defer')
    expect(gate.offer('toast', quiet, false, vi.fn())).toBe('defer')
    expect(gate.offer('autoAnswerCard', quiet, false, vi.fn())).toBe('defer')
    now = 250
    gate.refresh(input())
    expect(onReleased).toHaveBeenCalledOnce()
    expect(onReleased).toHaveBeenCalledWith({
      channels: ['toast', 'autoAnswerCard'],
      startedAtMs: 100,
      releasedAtMs: 250
    })
    gate.refresh(input())
    expect(onReleased).toHaveBeenCalledOnce()
  })
})
