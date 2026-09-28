import { describe, expect, it, vi } from 'vitest'
import { createRevealTrace, type RevealWindow } from './reveal-trace'

function windowState(visible: boolean): RevealWindow & { setVisible: (next: boolean) => void } {
  let current = visible
  return {
    isDestroyed: () => false,
    isVisible: () => current,
    setVisible: (next) => {
      current = next
    }
  }
}

describe('createRevealTrace', () => {
  it('audits created when no live window existed before reveal', () => {
    const audit = vi.fn()
    let win: RevealWindow | null = null
    let now = 10
    const trace = createRevealTrace({ audit, window: () => win, layout: () => 'bar', parked: () => false, now: () => now })

    const result = trace.trace('activate', () => {
      now = 25
      win = windowState(true)
      return 'created'
    })

    expect(result).toBe('created')
    expect(audit).toHaveBeenCalledExactlyOnceWith('reveal', {
      reason: 'activate',
      isVisible: false,
      parked: false,
      layout: 'bar',
      outcome: 'created',
      ms: 15
    })
  })

  it('audits shown when a hidden live window becomes visible', () => {
    const audit = vi.fn()
    const win = windowState(false)
    const trace = createRevealTrace({ audit, window: () => win, layout: () => 'island', parked: () => false, now: () => 1 })

    trace.trace('second-instance', () => win.setVisible(true))

    expect(audit).toHaveBeenCalledWith('reveal', expect.objectContaining({
      reason: 'second-instance',
      isVisible: false,
      parked: false,
      layout: 'island',
      outcome: 'shown',
      ms: 0
    }))
  })

  it('audits already-visible with the before parked state and hide layout', () => {
    const audit = vi.fn()
    const win = windowState(true)
    const trace = createRevealTrace({ audit, window: () => win, layout: () => 'hide', parked: () => true, now: () => 3 })

    trace.trace('activate', () => undefined)

    expect(audit).toHaveBeenCalledWith('reveal', expect.objectContaining({
      isVisible: true,
      parked: true,
      layout: 'hide',
      outcome: 'already-visible'
    }))
  })

  it('audits shown when a visible parked hairline becomes an interactive overlay', () => {
    const audit = vi.fn()
    const win = windowState(true)
    let parked = true
    const trace = createRevealTrace({ audit, window: () => win, layout: () => 'hide', parked: () => parked, now: () => 3 })

    trace.trace('activate', () => {
      parked = false
    })

    expect(audit).toHaveBeenCalledWith('reveal', expect.objectContaining({
      isVisible: true,
      parked: true,
      layout: 'hide',
      outcome: 'shown'
    }))
  })

  it('audits failed and rethrows when reveal throws', () => {
    const audit = vi.fn()
    const error = new Error('boom')
    const trace = createRevealTrace({ audit, window: () => windowState(false), layout: () => 'bar', parked: () => false, now: () => 5 })

    expect(() => trace.trace('ensure-window', () => { throw error })).toThrow(error)
    expect(audit).toHaveBeenCalledWith('reveal', expect.objectContaining({ outcome: 'failed' }))
  })

  it('audits failed when no live window remains after reveal', () => {
    const audit = vi.fn()
    let win: RevealWindow | null = windowState(false)
    const trace = createRevealTrace({ audit, window: () => win, layout: () => 'bar', parked: () => false, now: () => 5 })

    trace.trace('ensure-window', () => {
      win = null
    })

    expect(audit).toHaveBeenCalledWith('reveal', expect.objectContaining({ outcome: 'failed' }))
  })

  it('omits layout when reading layout throws and still runs reveal', () => {
    const audit = vi.fn()
    const reveal = vi.fn()
    const trace = createRevealTrace({
      audit,
      window: () => windowState(true),
      layout: () => { throw new Error('settings unavailable') },
      parked: () => false,
      now: () => 0
    })

    trace.trace('activate', reveal)

    expect(reveal).toHaveBeenCalledOnce()
    expect(audit.mock.calls[0][1]).not.toHaveProperty('layout')
  })
})
