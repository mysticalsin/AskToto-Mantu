import { describe, expect, it } from 'vitest'
import { COMMAND_RETURN_GUARD_MS, createReturnGuard } from './command-return-guard'

function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => (now += ms) }
}

describe('Return guard for the confirmation card (owner rule D-10)', () => {
  it('is 300 ms', () => {
    expect(COMMAND_RETURN_GUARD_MS).toBe(300)
  })

  it('ignores a Return that arrives inside 300 ms of the card appearing, then accepts a fresh one', () => {
    const time = clock()
    const guard = createReturnGuard({ now: time.now })
    expect(guard.acceptsReturn({ key: 'Enter' })).toBe(false)
    time.advance(299)
    expect(guard.acceptsReturn({ key: 'Enter' })).toBe(false)
    time.advance(1)
    expect(guard.acceptsReturn({ key: 'Enter' })).toBe(true)
  })

  it('never accepts an auto-repeat Return, so a key already held when the card appeared cannot confirm', () => {
    const time = clock()
    const guard = createReturnGuard({ now: time.now })
    time.advance(5_000)
    expect(guard.acceptsReturn({ key: 'Enter', repeat: true })).toBe(false)
    expect(guard.acceptsReturn({ key: 'Enter', repeat: false })).toBe(true)
  })

  it('ignores IME composition and every key other than Return', () => {
    const time = clock()
    const guard = createReturnGuard({ now: time.now })
    time.advance(1_000)
    expect(guard.acceptsReturn({ key: 'Enter', isComposing: true })).toBe(false)
    expect(guard.acceptsReturn({ key: ' ' })).toBe(false)
    expect(guard.acceptsReturn({ key: 'Escape' })).toBe(false)
  })

  it('lets a pointer click through at once but holds a keyboard-synthesised click (detail 0) for the guard window', () => {
    const time = clock()
    const guard = createReturnGuard({ now: time.now })
    expect(guard.acceptsClick({ detail: 1 })).toBe(true)
    expect(guard.acceptsClick({ detail: 0 })).toBe(false)
    time.advance(COMMAND_RETURN_GUARD_MS)
    expect(guard.acceptsClick({ detail: 0 })).toBe(true)
  })

  it('starts the window when the card is created, so a replaced card gets its own guard', () => {
    const time = clock()
    const first = createReturnGuard({ now: time.now })
    time.advance(1_000)
    const second = createReturnGuard({ now: time.now })
    expect(first.acceptsReturn({ key: 'Enter' })).toBe(true)
    expect(second.acceptsReturn({ key: 'Enter' })).toBe(false)
  })
})
