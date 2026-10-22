import { describe, expect, it, vi } from 'vitest'
import { createCrashReportLimiter, createReloadBudget, installGlobalCrashHandlers } from './renderer-crash-guard'

type Target = Parameters<typeof installGlobalCrashHandlers>[0]

type Listener = (event: unknown) => void

function fakeWindow(): {
  target: { addEventListener(t: string, l: Listener): void; removeEventListener(t: string, l: Listener): void }
  fire: (type: string, event: unknown) => void
  count: () => number
} {
  const listeners = new Map<string, Set<Listener>>()
  return {
    target: {
      addEventListener: (t, l) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l),
      removeEventListener: (t, l) => void listeners.get(t)?.delete(l)
    },
    fire: (type, event) => listeners.get(type)?.forEach((l) => l(event)),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0)
  }
}

describe('createReloadBudget (D10-8)', () => {
  it('reload escalates after 3 remounts within 60 s', () => {
    let t = 1_000
    const next = createReloadBudget(() => t)
    expect(next()).toBe('remount')
    t += 5_000
    expect(next()).toBe('remount')
    t += 5_000
    expect(next()).toBe('reload')
  })

  it('forgets remounts older than the window', () => {
    let t = 0
    const next = createReloadBudget(() => t)
    next()
    t += 30_000
    next()
    t += 31_000 // the first remount is now 61 s old
    expect(next()).toBe('remount')
  })
})

describe('createCrashReportLimiter (D10-8)', () => {
  it('allows at most one report a minute and five a session', () => {
    let t = 0
    const allow = createCrashReportLimiter(() => t)
    expect(allow()).toBe(true)
    t += 59_000
    expect(allow()).toBe(false)
    for (let i = 0; i < 4; i += 1) {
      t += 60_000
      expect(allow()).toBe(true)
    }
    t += 60_000
    expect(allow()).toBe(false) // the sixth in one session
  })
})

describe('installGlobalCrashHandlers (D10-8)', () => {
  it('reports an uncaught error and a rejected promise, rate-limited, with no crash card', () => {
    const win = fakeWindow()
    const report = vi.fn()
    const off = installGlobalCrashHandlers(win.target as unknown as Target, report, () => true)
    win.fire('error', { error: new Error('boom'), message: 'boom' })
    win.fire('unhandledrejection', { reason: new Error('later') })
    win.fire('unhandledrejection', { reason: 'a plain string' })
    expect(report).toHaveBeenCalledTimes(3)
    expect(report.mock.calls[0][0]).toMatchObject({ message: 'boom' })
    expect(report.mock.calls[1][0]).toMatchObject({ message: 'later' })
    expect(report.mock.calls[2][0]).toMatchObject({ message: 'a plain string' })
    off()
    expect(win.count()).toBe(0)
  })

  it('drops reports the limiter refuses and never throws out of a handler', () => {
    const win = fakeWindow()
    const report = vi.fn(() => {
      throw new Error('bridge gone')
    })
    installGlobalCrashHandlers(win.target as unknown as Target, report, () => false)
    expect(() => win.fire('error', { error: new Error('x') })).not.toThrow()
    expect(report).not.toHaveBeenCalled()
    installGlobalCrashHandlers(win.target as unknown as Target, report, () => true)
    expect(() => win.fire('error', { error: new Error('x') })).not.toThrow()
  })
})
