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
    const closed = sliceBetween('const self = win', '// Security: never let model-output')
    expect(closed).toMatch(/if \(win === self\)/)
    expect(closed).toMatch(/win = null/)
    expect(closed).toMatch(/stopOverlayCursorWatch/)
  })

  it('MQA-340 — a destroyed overlay never dereferences its own dead WebContents in the closed callback', () => {
    const closed = sliceBetween('const self = win', '// Security: never let model-output')
    expect(closed).toMatch(/const selfWebContentsId = self\.webContents\.id/)
    expect(closed).toMatch(/invalidateCloudSttOwner\(selfWebContentsId\)/)
    expect(closed).not.toMatch(/invalidateCloudSttOwner\(self\.webContents\.id\)/)
  })
})

describe('MQA-340 — onboarding durable saves reply before opaque-window replacement', () => {
  it('moves both destructive exclusive-stage transitions out of settings:set and behind separately guarded events', () => {
    const settingsSet = sliceBetween('ipcMain.handle(IPC.settingsSet', 'ipcMain.handle(IPC.settingsRecoverProfile')
    const completionTransition = sliceBetween(
      'const next = setSettingsWithSpeakerPolicy(p)',
      '// Flipping follow-up memory is itself a conversation boundary.'
    )
    expect(completionTransition).not.toMatch(/exitExclusiveOnboardingStage\(\)/)
    expect(completionTransition).not.toMatch(/applyExclusiveOnboardingStage\(win\)/)

    const completionEvent = sliceBetween('ipcMain.on(IPC.onboardingExit', 'ipcMain.handle(IPC.settingsSet')
    // `ipcMain.on` is fire-and-forget; throwing from a stale/unauthorized sender would crash main.
    expect(completionEvent).toMatch(/if \(!isMainWindowSender\(e\)\) return/)
    expect(completionEvent).not.toMatch(/assertMainWindow\(e\)/)
    expect(completionEvent).toMatch(/if \(onboardingExclusiveLive\(\)\) return/)
    expect(completionEvent).toMatch(/exitExclusiveOnboardingStage\(\)/)

    const replayEvent = sliceBetween('ipcMain.on(IPC.onboardingEnter', 'ipcMain.on(IPC.onboardingExit')
    expect(replayEvent).toMatch(/if \(!isMainWindowSender\(e\)\) return/)
    expect(replayEvent).not.toMatch(/assertMainWindow\(e\)/)
    expect(replayEvent).toMatch(/if \(!onboardingExclusiveLive\(\)\) return/)
    // The persisted false value makes onboardingExclusiveLive() true before the opaque replacement;
    // `overlayWindowTransparent` is the actual stage-state guard for a replay request.
    expect(replayEvent).toMatch(/!overlayWindowTransparent/)
    expect(replayEvent).toMatch(/applyExclusiveOnboardingStage\(win\)/)
  })

  it('recovers a completed opaque onboarding window only when its renderer misses the normal exit handoff', () => {
    const completionTransition = sliceBetween(
      'const next = setSettingsWithSpeakerPolicy(p)',
      '// Flipping follow-up memory is itself a conversation boundary.'
    )
    expect(completionTransition).toMatch(/cur\.onboardingDone === false\s*&&\s*next\.onboardingDone === true/)
    expect(completionTransition).toMatch(/!overlayWindowTransparent/)
    expect(completionTransition).toMatch(/armCompletedOnboardingExitFallback\(win\)/)
    expect(completionTransition).not.toMatch(/exitExclusiveOnboardingStage\(\)/)

    const completionEvent = sliceBetween('ipcMain.on(IPC.onboardingExit', 'ipcMain.handle(IPC.settingsSet')
    const cancel = completionEvent.indexOf('clearCompletedOnboardingExitFallback(win)')
    const exit = completionEvent.indexOf('exitExclusiveOnboardingStage()')
    expect(cancel).toBeGreaterThan(-1)
    expect(exit).toBeGreaterThan(cancel)

    const closed = sliceBetween('const self = win', '// Security: never let model-output')
    expect(closed).toMatch(/clearCompletedOnboardingExitFallback\(self\)/)
  })
})

describe('MQA-345 — constructor swaps keep the retiring renderer trusted until it closes', () => {
  it('defers replacement until the old BrowserWindow closes, without weakening normal IPC sender checks', () => {
    const recreate = sliceBetween('function recreateOverlayWindow(): void {', '/** Exclusive hero hold')
    const closeSubscription = recreate.indexOf("dying.once('closed', finishRecreate)")
    const destroy = recreate.indexOf('dying.destroy()')
    expect(closeSubscription).toBeGreaterThan(-1)
    expect(destroy).toBeGreaterThan(closeSubscription)
    expect(recreate).toMatch(/if \(win === dying\) win = null/)
    expect(recreate).toMatch(/createWindow\(\)/)
    expect(recreate.indexOf('rememberRetiringOverlaySender(dying)')).toBeGreaterThan(-1)
    expect(recreate.indexOf('rememberRetiringOverlaySender(dying)')).toBeLessThan(recreate.indexOf('dying.destroy()'))

    // Queued invokes from the just-retired renderer must remain subject to the same trusted-main-window
    // boundary. Only exact, briefly-retired top-level renderer identities receive teardown-safe defaults;
    // privileged writes still use assertMainWindow against the current live window.
    const retired = sliceBetween('const RETIRING_OVERLAY_IPC_GRACE_MS', 'type CloudSttIpcOwner')
    expect(retired).toMatch(/const RETIRING_OVERLAY_IPC_GRACE_MS = 5_000/)
    expect(retired).toMatch(/new Map<number, RetiringOverlaySender>/)
    expect(retired).toMatch(/contents: Electron\.WebContents/)
    expect(retired).toMatch(/event\.sender !== sender\.contents/)
    expect(retired).toMatch(/frame\.parent === null && frame\.url === sender\.url/)
    expect(retired).toMatch(/sender\.expiresAt <= Date\.now\(\)/)

    const localModels = sliceBetween('ipcMain.handle(IPC.localModelsList', '// Explicit Download/Retry')
    const park = sliceBetween('ipcMain.handle(IPC.overlayParkAfterHide', '// Renderer ErrorBoundary')
    const bundled = sliceBetween('ipcMain.handle(IPC.asrBundled', 'ipcMain.handle(IPC.asrAssetsStatus')
    expect(localModels.indexOf('isRecentlyRetiredOverlaySender(e)')).toBeLessThan(localModels.indexOf('assertMainWindow(e)'))
    expect(localModels).toMatch(/if \(isRecentlyRetiredOverlaySender\(e\)\) return \[\]/)
    expect(park.indexOf('isRecentlyRetiredOverlaySender(e)')).toBeLessThan(park.indexOf('assertMainWindow(e)'))
    expect(park).toMatch(/if \(isRecentlyRetiredOverlaySender\(e\)\) return/)
    expect(bundled.indexOf('isRecentlyRetiredOverlaySender(e)')).toBeLessThan(bundled.indexOf('assertMainWindow(e)'))
    expect(bundled).toMatch(/if \(isRecentlyRetiredOverlaySender\(e\)\) return true/)
    expect(indexSrc.match(/isRecentlyRetiredOverlaySender\(e\)/g)).toHaveLength(3)

    expect(localModels).toMatch(/assertMainWindow\(e\)/)
    expect(park).toMatch(/assertMainWindow\(e\)/)
    expect(bundled).toMatch(/assertMainWindow\(e\)/)
  })
})
