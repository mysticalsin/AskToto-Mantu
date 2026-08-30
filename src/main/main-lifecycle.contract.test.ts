import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * Source-contract tests for the main-process lifecycle findings (MQA-155, MQA-172). Same pattern as
 * index-audit-fixes.contract.test.ts / c-main-fixes.contract.test.ts: index.ts boots Electron at import
 * time, so both seams are lifted out of the raw source and executed here against stubs — the assertions
 * exercise the shipped expression, not merely its shape.
 */
// Normalized to LF: .gitattributes does not pin eol for src/**/*.ts, so a Windows checkout with
// core.autocrlf yields CRLF and every marker below containing a literal \n stops matching. These
// assertions are about the shipped expression, never about how git wrote the line endings.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

describe('MQA-155 — a failed post-sweep source refresh is observed, never fabricated into an app.crash', () => {
  type Deps = {
    sweepExpiredMeetings: (days: number) => Promise<{ deleted: number }>
    getSettings: () => { transcriptRetentionDays: number }
    auditLog: (event: string, detail: unknown) => void
    requestSourceRefresh: () => Promise<void>
    mainLog: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  }

  /** Lift the real runRetentionSweep closure and run it — the defect is a MISSING rejection handler, which
   *  only shows up when the refresh actually rejects. */
  const liftSweep = (deps: Deps): (() => void) => {
    const body = sliceBetween('const runRetentionSweep = (): void => {', 'runRetentionSweep()').replace(
      '(): void =>',
      '() =>'
    )
    const build = new Function(
      'sweepExpiredMeetings',
      'getSettings',
      'auditLog',
      'requestSourceRefresh',
      'mainLog',
      `${body}\nreturn runRetentionSweep`
    ) as (...args: unknown[]) => () => void
    return build(
      deps.sweepExpiredMeetings,
      deps.getSettings,
      deps.auditLog,
      deps.requestSourceRefresh,
      deps.mainLog
    )
  }

  it('MQA-155 — attaches a rejection handler to the refresh fired after expired meetings are deleted', async () => {
    const failure = new Error('EBUSY: .brain/index.json is locked by the sync client')
    // A stand-in for the promise requestSourceRefresh returns. `void p` does NOT observe p; only an
    // explicit .catch does, so an untouched spy here is exactly the unhandledRejection → persistCrash path.
    const observe = vi.fn((onRejected: (e: unknown) => unknown) => {
      onRejected(failure)
      return Promise.resolve()
    })
    const mainLog = { warn: vi.fn(), error: vi.fn() }
    const requestSourceRefresh = vi.fn(() => ({ catch: observe }) as unknown as Promise<void>)

    liftSweep({
      sweepExpiredMeetings: () => Promise.resolve({ deleted: 2 }),
      getSettings: () => ({ transcriptRetentionDays: 30 }),
      auditLog: vi.fn(),
      requestSourceRefresh,
      mainLog
    })()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(requestSourceRefresh).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledTimes(1)
    const logged = [...mainLog.warn.mock.calls, ...mainLog.error.mock.calls].flat().join(' ')
    expect(logged).toContain(failure.message)
  })

  it('MQA-155 — the two fire-and-forget refreshes in ingest.ts observe their rejections too', () => {
    // Same defect shape, same 6-hour blast radius: reconcileMeetingsInBackground's try/catch cannot catch
    // an async rejection, so a bare `void` there re-fabricates a crash record every 60s while fs stays hot.
    const ingestSrc = readFileSync(join(__dirname, 'brain', 'ingest.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(ingestSrc).not.toMatch(/void requestSourceRefresh\([^)]*\)\s*$/m)
  })
})

describe('MQA-172 — a second launch after a failed boot window recreates it instead of doing nothing', () => {
  type Win = { isVisible: () => boolean; isDestroyed: () => boolean; showInactive: () => void }

  /** Execute the real `app.on('second-instance', ...)` registration and hand back the handler it installs. */
  const secondInstanceHandler = (win: Win | null, ensureWindow: () => Win | null): (() => void) => {
    const src = sliceBetween("app.on('second-instance'", 'app.whenReady()')
    let handler: (() => void) | null = null
    const app = {
      on: (_event: string, fn: () => void) => {
        handler = fn
      }
    }
    ;(new Function('app', 'win', 'ensureWindow', src) as (...args: unknown[]) => void)(app, win, ensureWindow)
    expect(handler, 'second-instance handler was never registered').not.toBeNull()
    return handler as unknown as () => void
  }

  it('MQA-172 — self-heals a null window through ensureWindow() rather than silently returning', () => {
    const recovered: Win = {
      isVisible: () => false,
      isDestroyed: () => false,
      showInactive: vi.fn()
    }
    const ensureWindow = vi.fn(() => recovered)

    // `win === null` is the state a boot-time createWindow() throw leaves behind (index.ts nulls it and
    // rethrows into runStep, which swallows). The app then lives on in the tray with no window at all.
    secondInstanceHandler(null, ensureWindow)()

    expect(ensureWindow).toHaveBeenCalledTimes(1)
    // Non-activating reveal (island Phase 1 showInactive() audit) — a second launch must not steal focus.
    expect(recovered.showInactive).toHaveBeenCalledTimes(1)
  })

  it('MQA-172 — still just raises an existing hidden window without rebuilding it', () => {
    const existing: Win = { isVisible: () => false, isDestroyed: () => false, showInactive: vi.fn() }
    secondInstanceHandler(existing, () => existing)()
    expect(existing.showInactive).toHaveBeenCalledTimes(1)
  })

  it('MQA-172 — an already-visible window is left alone (no redundant showInactive)', () => {
    const visible: Win = { isVisible: () => true, isDestroyed: () => false, showInactive: vi.fn() }
    secondInstanceHandler(visible, () => visible)()
    expect(visible.showInactive).not.toHaveBeenCalled()
  })

  it('MQA-172 — createWindow() is idempotent, so the boot step cannot orphan a recovered window', () => {
    // ensureWindow() may now run during the async gap between the handler registration and boot's own
    // runStep('createWindow'). Without this guard the boot step would overwrite `win` with a second
    // BrowserWindow, leaving the first visible, always-on-top and unreferenced.
    const head = sliceBetween('function createWindow(): void {', 'isMinimized = false')
    expect(head).toMatch(/if \(win && !win\.isDestroyed\(\)\) return/)
  })

  it("MQA-172 — the 'closed' handler only clears the module ref when it still points at that window", () => {
    const closed = sliceBetween("const self = win\n  win.on('closed', () => {", '// Security: never let model-output')
    expect(closed).toMatch(/if \(win === self\)/)
    expect(closed).toMatch(/win = null/)
    expect(closed).toMatch(/stopOverlayCursorWatch/)
  })
})
