import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * M2-0006 — behavioral pins for the four observability call sites added to createWindow()/will-quit in
 * index.ts (index.ts boots Electron at import time, so it cannot be imported directly — same seam as
 * main-lifecycle.contract.test.ts). Each snippet is lifted out of the real source with its exact
 * surrounding markers and actually EXECUTED against stubs, so a regression has to break real control flow
 * to slip past these, not just reword a comment or rename a local.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Markers are matched at collection time (called from describe bodies, not inside it()), so a drifted
 *  marker must fail loudly with a real Error — not an expect() outside a test, which vitest also runs but
 *  which is a less direct signal. Same convention as bank-grade-hardening.contract.test.ts. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  if (start === -1) throw new Error(`marker not found: ${from}`)
  const end = indexSrc.indexOf(to, start)
  if (end === -1) throw new Error(`end marker not found after ${from}: ${to}`)
  return indexSrc.slice(start, end)
}

/** Like sliceBetween, but the end marker is found from the END of the file backwards — for a snippet that
 *  is the last content before index.ts's final closing brace, where the usual forward search would stop
 *  at the WRONG "})" (there are many before it). */
function sliceToLastCloseParen(from: string): string {
  const start = indexSrc.indexOf(from)
  if (start === -1) throw new Error(`marker not found: ${from}`)
  const end = indexSrc.lastIndexOf('})')
  if (end <= start) throw new Error(`no '})' found after ${from}`)
  return indexSrc.slice(start, end)
}

describe('M2-0006 — app.started gains bootId/prevBootId/prevShutdown/prevLastAliveAt and starts the two timers', () => {
  const body = sliceBetween("const { bootId, prior } = beginRunWatch(app.getPath('userData'))", "  }\n  // Crash/recovery guard")

  function build(): (...args: unknown[]) => { currentBootId: string | undefined; stallMonitor: unknown } {
    return new Function(
      'app',
      'beginRunWatch',
      'auditLog',
      'trackTimer',
      'markAlive',
      'startStallMonitor',
      'setInterval',
      `let currentBootId; let stallMonitor; let emittedAppStarted = false;\n${body}\nreturn { currentBootId, stallMonitor }`
    ) as (...args: unknown[]) => { currentBootId: string | undefined; stallMonitor: unknown }
  }

  it('audits app.started with the fields beginRunWatch reports, and remembers the bootId for will-quit', () => {
    const auditLog = vi.fn()
    const beginRunWatch = vi.fn(() => ({
      bootId: 'boot-42',
      prior: { prevBootId: 'boot-41', prevShutdown: 'clean', prevLastAliveAt: '2026-01-01T00:00:00.000Z' }
    }))
    const app = { getPath: () => '/fake/userData', getVersion: () => '1.9.7' }
    const setIntervalFn = vi.fn(() => 1 as unknown as NodeJS.Timeout)
    const trackTimer = vi.fn((t: unknown) => t)
    const startStallMonitor = vi.fn(() => ({ stop: vi.fn() }))
    const markAlive = vi.fn()

    const result = build()(app, beginRunWatch, auditLog, trackTimer, markAlive, startStallMonitor, setIntervalFn)

    expect(beginRunWatch).toHaveBeenCalledExactlyOnceWith('/fake/userData')
    expect(auditLog).toHaveBeenCalledWith('app.started', {
      version: '1.9.7',
      platform: process.platform,
      arch: process.arch,
      bootId: 'boot-42',
      prevBootId: 'boot-41',
      prevShutdown: 'clean',
      prevLastAliveAt: '2026-01-01T00:00:00.000Z'
    })
    expect(result.currentBootId).toBe('boot-42')
  })

  it('starts a 10s tracked timer that calls markAlive with the current bootId', () => {
    const setIntervalFn = vi.fn((_handler: () => void, _ms: number) => 1 as unknown as NodeJS.Timeout)
    const trackTimer = vi.fn((t: unknown) => t)
    const markAlive = vi.fn()
    build()(
      { getPath: () => '/fake', getVersion: () => '1.9.7' },
      () => ({ bootId: 'boot-1', prior: { prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined } }),
      vi.fn(),
      trackTimer,
      markAlive,
      vi.fn(() => ({ stop: vi.fn() })),
      setIntervalFn
    )
    expect(setIntervalFn).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 10_000)
    expect(trackTimer).toHaveBeenCalledOnce()
    setIntervalFn.mock.calls[0][0]()
    expect(markAlive).toHaveBeenCalledExactlyOnceWith('/fake', 'boot-1')
  })

  it('starts the stall monitor for this bootId and wires its callbacks to app.stall / app.stall.summary', () => {
    const auditLog = vi.fn()
    let captured: { onStall: (d: unknown) => void; onSummary: (d: unknown) => void } | undefined
    const startStallMonitor = vi.fn((opts: typeof captured) => {
      captured = opts
      return { stop: vi.fn() }
    })
    const result = build()(
      { getPath: () => '/fake', getVersion: () => '1.9.7' },
      () => ({ bootId: 'boot-9', prior: { prevBootId: undefined, prevShutdown: 'unknown', prevLastAliveAt: undefined } }),
      auditLog,
      vi.fn((t: unknown) => t),
      vi.fn(),
      startStallMonitor,
      vi.fn(() => 1 as unknown as NodeJS.Timeout)
    )
    expect(startStallMonitor).toHaveBeenCalledWith(expect.objectContaining({ bootId: 'boot-9' }))
    captured!.onStall({ bootId: 'boot-9', durationMs: 1500 })
    expect(auditLog).toHaveBeenCalledWith('app.stall', { bootId: 'boot-9', durationMs: 1500 })
    captured!.onSummary({ bootId: 'boot-9', p99Ms: 7 })
    expect(auditLog).toHaveBeenCalledWith('app.stall.summary', { bootId: 'boot-9', p99Ms: 7 })
    expect(result.stallMonitor).toEqual({ stop: expect.any(Function) })
  })
})

describe('M2-0006 — app.renderer.ready fires regardless of ASKTOTO_MAC_LAUNCH_GATE', () => {
  const body = sliceBetween(
    "bindRendererReadiness(win.webContents, rendererUrl, () => {",
    '\n  // Bounded launch evidence only'
  )
  const originalGate = process.env.ASKTOTO_MAC_LAUNCH_GATE

  it.each([undefined, '0', '1'] as const)('binds the readiness probe and audits app.renderer.ready when the gate is %s', (gate) => {
    if (gate === undefined) delete process.env.ASKTOTO_MAC_LAUNCH_GATE
    else process.env.ASKTOTO_MAC_LAUNCH_GATE = gate
    try {
      const win = { webContents: {} }
      const rendererUrl = 'file:///fixture/index.html'
      const auditLog = vi.fn()
      const app = { getVersion: () => '1.9.7' }
      let readyCallback: (() => void) | undefined
      const bindRendererReadiness = vi.fn((_target: unknown, _url: string, cb: () => void) => {
        readyCallback = cb
      })
      new Function('bindRendererReadiness', 'win', 'rendererUrl', 'auditLog', 'app', body)(
        bindRendererReadiness,
        win,
        rendererUrl,
        auditLog,
        app
      )
      expect(bindRendererReadiness).toHaveBeenCalledExactlyOnceWith(win.webContents, rendererUrl, expect.any(Function))
      readyCallback!()
      expect(auditLog).toHaveBeenCalledWith('app.renderer.ready', {
        version: '1.9.7',
        platform: process.platform,
        arch: process.arch
      })
    } finally {
      if (originalGate === undefined) delete process.env.ASKTOTO_MAC_LAUNCH_GATE
      else process.env.ASKTOTO_MAC_LAUNCH_GATE = originalGate
    }
  })
})

describe("M2-0006 — app.responsive pairs app.unresponsive with how long the renderer was wedged", () => {
  // Starts after the `let unresponsiveSince: number | null = null` declaration, not at it: that line's
  // type annotation is valid TypeScript but not valid plain JavaScript, and new Function evaluates plain
  // JS. The wrapper below declares the same local without the annotation instead.
  const body = sliceBetween(
    "win.on('unresponsive', () => {",
    "win.webContents.on('render-process-gone'"
  )

  class FakeWindow extends EventEmitter {}

  function bind(win: FakeWindow, self: FakeWindow, mainLog: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> }, auditLog: ReturnType<typeof vi.fn>): void {
    new Function('win', 'self', 'mainLog', 'auditLog', `let unresponsiveSince = null;\n${body}`)(win, self, mainLog, auditLog)
  }

  it('audits app.responsive with the elapsed stallMs after a matching app.unresponsive', () => {
    const win = new FakeWindow()
    const mainLog = { warn: vi.fn(), info: vi.fn() }
    const auditLog = vi.fn()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      bind(win, win, mainLog, auditLog)
      win.emit('unresponsive')
      expect(auditLog).toHaveBeenCalledWith('app.unresponsive', { kind: 'overlay' })
      vi.setSystemTime(1_700_000_000_000 + 4200)
      win.emit('responsive')
      expect(auditLog).toHaveBeenCalledWith('app.responsive', { kind: 'overlay', stallMs: 4200 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never audits app.responsive without a preceding app.unresponsive', () => {
    const win = new FakeWindow()
    const auditLog = vi.fn()
    bind(win, win, { warn: vi.fn(), info: vi.fn() }, auditLog)
    win.emit('responsive')
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('ignores events from a stale window instance (win !== self), same guard as app.unresponsive', () => {
    const win = new FakeWindow()
    const otherSelf = new FakeWindow()
    const auditLog = vi.fn()
    bind(win, otherSelf, { warn: vi.fn(), info: vi.fn() }, auditLog)
    win.emit('unresponsive')
    win.emit('responsive')
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('a second, unmatched app.unresponsive does not double-count a stall already paired off', () => {
    const win = new FakeWindow()
    const auditLog = vi.fn()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      bind(win, win, { warn: vi.fn(), info: vi.fn() }, auditLog)
      win.emit('unresponsive')
      vi.setSystemTime(1000)
      win.emit('responsive')
      auditLog.mockClear()
      win.emit('responsive') // no unresponsive happened since the last pairing
      expect(auditLog).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('M2-0006 — will-quit writes app.shutdown.clean and stops the stall monitor, last', () => {
  const body = sliceToLastCloseParen('// M2-0006: last, so it only fires')

  function run(deps: {
    stallMonitor: { stop: () => void } | null
    mainLog: { warn: ReturnType<typeof vi.fn> }
    currentBootId: string | undefined
    app: { getPath: () => string }
    markShutdownClean: (...args: unknown[]) => unknown
    auditLog: ReturnType<typeof vi.fn>
  }): void {
    new Function('stallMonitor', 'mainLog', 'currentBootId', 'app', 'markShutdownClean', 'auditLog', body)(
      deps.stallMonitor,
      deps.mainLog,
      deps.currentBootId,
      deps.app,
      deps.markShutdownClean,
      deps.auditLog
    )
  }

  it('stops the stall monitor and audits app.shutdown.clean with markShutdownClean\'s detail', () => {
    const stop = vi.fn()
    const auditLog = vi.fn()
    const markShutdownClean = vi.fn(() => ({ bootId: 'boot-7', uptimeS: 42, reason: 'will-quit' }))
    run({
      stallMonitor: { stop },
      mainLog: { warn: vi.fn() },
      currentBootId: 'boot-7',
      app: { getPath: () => '/fake' },
      markShutdownClean,
      auditLog
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(markShutdownClean).toHaveBeenCalledWith('/fake', 'boot-7', expect.any(Number))
    expect(auditLog).toHaveBeenCalledExactlyOnceWith('app.shutdown.clean', { bootId: 'boot-7', uptimeS: 42, reason: 'will-quit' })
  })

  it('never calls markShutdownClean when no bootId was ever recorded (will-quit before app.started)', () => {
    const auditLog = vi.fn()
    const markShutdownClean = vi.fn()
    run({
      stallMonitor: null,
      mainLog: { warn: vi.fn() },
      currentBootId: undefined,
      app: { getPath: () => '/fake' },
      markShutdownClean,
      auditLog
    })
    expect(markShutdownClean).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
  })

  it('a throwing stallMonitor.stop() is caught and never blocks the shutdown-clean audit', () => {
    const auditLog = vi.fn()
    const markShutdownClean = vi.fn(() => ({ bootId: 'boot-7', uptimeS: 1, reason: 'will-quit' }))
    const warn = vi.fn()
    run({
      stallMonitor: { stop: () => { throw new Error('boom') } },
      mainLog: { warn },
      currentBootId: 'boot-7',
      app: { getPath: () => '/fake' },
      markShutdownClean,
      auditLog
    })
    expect(warn).toHaveBeenCalledWith('[will-quit] stallMonitor.stop failed', expect.any(Error))
    expect(auditLog).toHaveBeenCalledExactlyOnceWith('app.shutdown.clean', { bootId: 'boot-7', uptimeS: 1, reason: 'will-quit' })
  })

  it('a null stallMonitor (will-quit before app.started ever ran) is a safe no-op', () => {
    const auditLog = vi.fn()
    run({
      stallMonitor: null,
      mainLog: { warn: vi.fn() },
      currentBootId: undefined,
      app: { getPath: () => '/fake' },
      markShutdownClean: vi.fn(),
      auditLog
    })
    expect(auditLog).not.toHaveBeenCalled()
  })
})
