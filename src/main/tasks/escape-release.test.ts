import { describe, expect, it, vi } from 'vitest'
import { ESCAPE_RELEASE_DEADLINE_MS, createEscapeRelease, type EscapeKeySource } from './escape-release'

function harness(options: { armable?: boolean; restore?: () => Promise<void> } = {}) {
  let clock = 1_000
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const handlers: Array<() => void> = []
  const disarm = vi.fn()
  const source: EscapeKeySource = {
    arm: (onEscape) => {
      if (options.armable === false) return null
      handlers.push(onEscape)
      return disarm
    }
  }
  const audit = vi.fn()
  const stop = vi.fn()
  const restoreFocus = vi.fn(options.restore ?? (async () => undefined))
  const release = createEscapeRelease({
    source,
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const t = { at: clock + ms, fn, live: true }
        timers.push(t)
        return t
      },
      clear: (h) => {
        ;(h as { live: boolean }).live = false
      }
    },
    audit
  })
  return {
    release,
    stop,
    restoreFocus,
    audit,
    disarm,
    press: () => handlers[0]?.(),
    advance: (ms: number) => {
      clock += ms
      for (const t of timers) if (t.live && t.at <= clock) (t.live = false), t.fn()
    }
  }
}

describe('Escape release (G40)', () => {
  it('uses the PROPOSED 300 ms deadline', () => {
    expect(ESCAPE_RELEASE_DEADLINE_MS).toBe(300)
  })

  it('cannot hold control when Escape cannot be armed', () => {
    const h = harness({ armable: false })
    expect(
      h.release.hold({ actionId: 'desktop.photo_booth_capture', stop: h.stop, restoreFocus: h.restoreFocus })
    ).toBeNull()
  })

  it('stops the step at once and returns focus within the deadline', async () => {
    const h = harness()
    const hold = h.release.hold({ actionId: 'desktop.photo_booth_capture', stop: h.stop, restoreFocus: h.restoreFocus })
    expect(hold).not.toBeNull()
    h.press()
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.disarm).toHaveBeenCalledTimes(1)
    const report = await hold!.escaped
    expect(report).toMatchObject({ withinDeadline: true, focus: 'restored' })
    expect(h.audit).toHaveBeenCalledWith(
      'task.escape_release',
      expect.objectContaining({ actionId: 'desktop.photo_booth_capture', withinDeadline: 'yes', focus: 'restored' })
    )
  })

  it('reports a slow focus return as outside the deadline but has already stopped the step', async () => {
    const h = harness({ restore: () => new Promise<void>(() => undefined) })
    const hold = h.release.hold({
      actionId: 'desktop.photo_booth_capture',
      stop: h.stop,
      restoreFocus: h.restoreFocus
    })!
    h.press()
    expect(h.stop).toHaveBeenCalledTimes(1)
    h.advance(ESCAPE_RELEASE_DEADLINE_MS)
    const report = await hold.escaped
    expect(report).toMatchObject({ withinDeadline: false, focus: 'timed_out' })
    expect(h.audit).toHaveBeenCalledWith('task.escape_release', expect.objectContaining({ withinDeadline: 'no' }))
  })

  it('treats a failed focus return as a release that did not restore, never as a thrown error', async () => {
    const h = harness({ restore: async () => Promise.reject(new Error('helper gone')) })
    const hold = h.release.hold({
      actionId: 'desktop.photo_booth_capture',
      stop: h.stop,
      restoreFocus: h.restoreFocus
    })!
    h.press()
    expect((await hold.escaped)?.focus).toBe('failed')
  })

  it('releases only once and stops listening when the step ends normally', async () => {
    const h = harness()
    const hold = h.release.hold({
      actionId: 'desktop.photo_booth_capture',
      stop: h.stop,
      restoreFocus: h.restoreFocus
    })!
    h.press()
    h.press()
    expect(h.stop).toHaveBeenCalledTimes(1)
    await hold.escaped

    const normal = harness()
    const second = normal.release.hold({
      actionId: 'desktop.photo_booth_capture',
      stop: normal.stop,
      restoreFocus: normal.restoreFocus
    })!
    second.end()
    second.end()
    expect(normal.disarm).toHaveBeenCalledTimes(1)
    normal.press()
    expect(normal.stop).not.toHaveBeenCalled()
    expect(normal.restoreFocus).not.toHaveBeenCalled()
  })

  it('a stop that throws still returns focus', async () => {
    const h = harness()
    h.stop.mockImplementation(() => {
      throw new Error('boom')
    })
    const hold = h.release.hold({
      actionId: 'desktop.photo_booth_capture',
      stop: h.stop,
      restoreFocus: h.restoreFocus
    })!
    h.press()
    expect((await hold.escaped)?.focus).toBe('restored')
  })
})
