import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createScreenPreprocess, fnv1a, type ScreenPreprocessDeps } from './screen-preprocess'
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'

/** A controllable harness: a fake clock, a fake foreground watcher whose "current" window the test can
 *  move, a settings object the test can flip, and a fake fetch whose body + call count the test inspects. */
function makeHarness(init?: {
  backgroundScreenContext?: boolean
  localReady?: boolean
  privateView?: boolean
  activeStreams?: number
  /** A high-memory import can defer background VLM work but must not disable OCR. */
  allowSpeculativeLocalWork?: boolean
  /** Inject the optional OCR dep (mac path). ocrText/ocrThrow on state drive its behavior per test. */
  withOcr?: boolean
  /** SSO session state — the engine's own gate, so canRun() answers for the Settings copy too. */
  authorized?: boolean
  /** Foreground-watcher health at start(): false is linux / a mac install with no bundled helper. */
  watcherHealthy?: boolean
  /** Platform screen-capture grant. macOS reads TCC; Windows reads the live probe/outcome cache. */
  screenCaptureGranted?: boolean
  platform?: NodeJS.Platform | string
}) {
  let clock = 1_000_000
  const state = {
    backgroundScreenContext: init?.backgroundScreenContext ?? true,
    localReady: init?.localReady ?? true,
    privateView: init?.privateView ?? false,
    activeStreams: init?.activeStreams ?? 0,
    speculativeLocalWorkAllowed: init?.allowSpeculativeLocalWork ?? true,
    image: 'IMG_A',
    describeBody: 'A code editor with an error panel.' as string | null,
    ocrText: null as string | null,
    ocrThrow: false,
    authorized: init?.authorized ?? true,
    watcherHealthy: init?.watcherHealthy ?? true,
    screenCaptureGranted: init?.screenCaptureGranted ?? true,
    /** Display the capture actually came from, and the display the user is looking at right now. */
    dispId: 1,
    currentDisplayId: 1,
    displayMismatch: false,
    /** When set, every capture rejects with this message (a permission that is not in effect). */
    captureError: null as string | null
  }
  const audits: { event: string; data?: Record<string, unknown> }[] = []
  let ocrCalls = 0
  let shots = 0
  let currentWin: ForegroundInfo | null = null
  let watcher: ForegroundWatcher | null = null
  let fetchCalls = 0
  const ensureStarted = vi.fn(async () => {})

  const fetchImpl = vi.fn(async () => {
    fetchCalls++
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: state.describeBody } }] })
    } as unknown as Response
  })

  const deps = {
    // Counted, because on macOS this call IS the permission prompt: a capture taken while the Screen
    // Recording grant is still `not-determined` is what registers the app with TCC (MQA-209).
    getScreenshot: async () => {
      shots++
      if (state.captureError) throw new Error(state.captureError)
      return {
        image: state.image,
        width: 1280,
        height: 800,
        capturedAt: clock,
        dispId: state.dispId,
        displayMismatch: state.displayMismatch
      }
    },
    getSettings: () => ({
      backgroundScreenContext: state.backgroundScreenContext,
      localLlm: { enabled: true, modelId: 'qwen3.5-0.8b' }
    }),
    localReady: () => state.localReady,
    authorized: () => state.authorized,
    currentDisplayId: () => state.currentDisplayId,
    privateViewOn: () => state.privateView,
    allowSpeculativeLocalWork: () => state.speculativeLocalWorkAllowed,
    ensureLocalRuntimeStarted: ensureStarted,
    runtime: {
      baseURL: () => 'http://127.0.0.1:9999/v1',
      sessionKey: () => 'sk-test',
      markActivity: vi.fn(),
      beginStream: vi.fn(),
      endStream: vi.fn(),
      activeStreams: () => state.activeStreams
    },
    startWatcher: (onChange) => {
      // Record onChange so the test can drive it; expose current() over the harness-controlled window.
      void onChange
      watcher = { stop: vi.fn(), current: () => currentWin, healthy: () => state.watcherHealthy }
      return watcher
    },
    extractScreenText: init?.withOcr
      ? async () => {
          ocrCalls++
          if (state.ocrThrow) throw new Error('helper died')
          return state.ocrText
        }
      : undefined,
    // Wired only when the test asks for it, mirroring index.ts: the dep exists on darwin and nowhere else.
    screenCaptureGranted:
      init?.screenCaptureGranted === undefined ? undefined : () => state.screenCaptureGranted,
    fetchImpl,
    now: () => clock,
    log: () => {},
    audit: (event: string, data?: Record<string, unknown>) => {
      audits.push({ event, data })
    },
    platform: init?.platform ?? 'darwin'
  } as ScreenPreprocessDeps & { allowSpeculativeLocalWork?: () => boolean }

  const sp = createScreenPreprocess(deps)
  return {
    sp,
    state,
    ensureStarted,
    advance: (ms: number) => {
      clock += ms
    },
    setWindow: (windowId: string) => {
      currentWin = { windowId, pid: 1, title: 't' }
    },
    setSpeculativeLocalWorkAllowed: (allowed: boolean) => {
      state.speculativeLocalWorkAllowed = allowed
    },
    fetchCalls: () => fetchCalls,
    ocrCalls: () => ocrCalls,
    shots: () => shots,
    audits,
    peek: () => sp._test.peekCache()
  }
}

describe('fnv1a', () => {
  it('is stable and distinguishes different content', () => {
    expect(fnv1a('IMG_A')).toBe(fnv1a('IMG_A'))
    expect(fnv1a('IMG_A')).not.toBe(fnv1a('IMG_B'))
  })
})

describe('createScreenPreprocess — describe + cache', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => {
    h = makeHarness()
    h.sp.refresh() // eligible → starts (sets the fake watcher so window matching works)
    h.setWindow('w1')
  })

  it('describes the screen once and serves it as fresh context for the focused window', async () => {
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(1)
    const ctx = h.sp.currentFreshContext()
    expect(ctx?.description).toBe('A code editor with an error panel.')
  })

  it('screen-hash dedupe: an unchanged screen refreshes the stamp WITHOUT re-inferring', async () => {
    await h.sp._test.describeForWindow('w1')
    const firstAt = h.peek()?.capturedAt
    h.advance(3000) // past MIN_DESCRIBE_INTERVAL so the throttle doesn't mask the dedupe
    await h.sp._test.describeForWindow('w1') // same image → same hash
    expect(h.fetchCalls()).toBe(1) // no second describe
    expect(h.peek()?.capturedAt).toBeGreaterThan(firstAt!) // but freshness bumped
  })

  it('re-describes when the screen content actually changes', async () => {
    await h.sp._test.describeForWindow('w1')
    h.advance(3000)
    h.state.image = 'IMG_B'
    h.state.describeBody = 'A browser on a docs page.'
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(2)
    expect(h.sp.currentFreshContext()?.description).toBe('A browser on a docs page.')
  })

  it('serves null when focus has moved to a different window since the describe', async () => {
    await h.sp._test.describeForWindow('w1')
    expect(h.sp.currentFreshContext()).not.toBeNull()
    h.setWindow('w2') // user alt-tabbed away
    expect(h.sp.currentFreshContext()).toBeNull()
  })

  // MQA-035 (docs/qa/BUG-LEDGER.md): describeForWindow refuses to BUILD a description under Private
  // View, but only runs on the 6s refresh tick — so a description captured just before the user hit
  // Private View stayed readable, and both the screen:context IPC and askStart's injection would hand
  // it to a CLOUD provider for up to a full tick after the user asked for privacy.
  it('serves null the instant Private View turns on, without waiting for the next refresh tick (MQA-035)', async () => {
    await h.sp._test.describeForWindow('w1')
    expect(h.sp.currentFreshContext()).not.toBeNull() // cached while Private View was off

    h.state.privateView = true // user flips the switch — no tick has run yet

    expect(h.sp.currentFreshContext()).toBeNull()
    // …and the cache is dropped, so turning Private View back off cannot resurrect the old description.
    h.state.privateView = false
    expect(h.sp.currentFreshContext()).toBeNull()
  })

  it('serves null once the cached description ages past the freshness TTL', async () => {
    await h.sp._test.describeForWindow('w1')
    expect(h.sp.currentFreshContext()).not.toBeNull()
    h.advance(13_000) // > CONTEXT_TTL_MS (12s)
    expect(h.sp.currentFreshContext()).toBeNull()
  })

  it('does not commit a description if focus changed mid-describe (wrong-window guard)', async () => {
    // describeForWindow('w1') suspends at its first await (getScreenshot); flip focus to w2 before it
    // resolves. At commit time activeWindowId() is 'w2' ≠ 'w1', so the w1 description must NOT be cached.
    const p = h.sp._test.describeForWindow('w1')
    h.setWindow('w2')
    await p
    expect(h.peek()).toBeNull()
  })
})

describe('createScreenPreprocess — gating', () => {
  it('does nothing when the backgroundScreenContext setting is off', async () => {
    const h = makeHarness({ backgroundScreenContext: false })
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(0)
    expect(h.sp.isActive()).toBe(false)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false) // refresh must not start it while ineligible
  })

  it('does nothing when the local model is not ready', async () => {
    const h = makeHarness({ localReady: false })
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(0)
  })

  it('drops any cached description and skips the describe while Private View is on', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.peek()).not.toBeNull()
    h.state.privateView = true
    h.advance(3000)
    await h.sp._test.describeForWindow('w1')
    expect(h.peek()).toBeNull() // cache cleared
    expect(h.fetchCalls()).toBe(1) // no describe attempted under Private View
  })

  it('yields to a real in-flight local stream instead of competing for a slot', async () => {
    const h = makeHarness({ activeStreams: 1 })
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(0)
  })

  it('defers speculative VLM work during a memory-heavy import without disabling the screen reader itself', async () => {
    const h = makeHarness({ allowSpeculativeLocalWork: false })
    h.sp.refresh()
    h.setWindow('w1')

    await h.sp._test.describeForWindow('w1')

    expect(h.sp.isActive()).toBe(true)
    expect(h.ensureStarted).not.toHaveBeenCalled()
    expect(h.fetchCalls()).toBe(0)
    expect(h.peek()).toBeNull()
  })

  it('rechecks the speculative gate after runtime admission before sending the background VLM request', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.ensureStarted.mockImplementationOnce(async () => {
      h.setSpeculativeLocalWorkAllowed(false)
    })

    await h.sp._test.describeForWindow('w1')

    expect(h.ensureStarted).toHaveBeenCalledWith('qwen3.5-0.8b', true, expect.any(Function))
    expect(h.fetchCalls()).toBe(0)
    expect(h.peek()).toBeNull()
  })

  it('throttles: a second describe inside the minimum interval is skipped', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    h.state.image = 'IMG_B' // even a changed screen must wait out the throttle
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(1)
  })
})

describe('createScreenPreprocess — window change invalidation', () => {
  it('handleWindowChange immediately drops the stale description for the window just left', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.peek()).not.toBeNull()
    h.sp._test.handleWindowChange({ windowId: 'w2', pid: 2, title: 'other' })
    expect(h.peek()).toBeNull() // cache dropped synchronously on the change
    h.sp.stop() // clear the debounce timer the change scheduled
  })
})

describe('createScreenPreprocess — OCR-first hybrid (mac Vision helper)', () => {
  it('uses the OCR extract when present: no VLM call, no llama runtime spin-up', async () => {
    const h = makeHarness({ withOcr: true })
    h.state.ocrText = "Text visible on the user's screen (OCR extract, top to bottom):\nQ3 pipeline review"
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.peek()?.description).toContain('Q3 pipeline review')
    expect(h.ocrCalls()).toBe(1)
    expect(h.fetchCalls()).toBe(0) // VLM describe never ran
    expect(h.ensureStarted).not.toHaveBeenCalled() // OCR path never touches llama-server
  })

  it('falls back to the VLM caption when OCR returns null (text-poor screen)', async () => {
    const h = makeHarness({ withOcr: true })
    h.state.ocrText = null
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.ocrCalls()).toBe(1)
    expect(h.fetchCalls()).toBe(1)
    expect(h.peek()?.description).toBe('A code editor with an error panel.')
  })

  it('falls back to the VLM caption when the OCR helper throws', async () => {
    const h = makeHarness({ withOcr: true })
    h.state.ocrThrow = true
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(1)
    expect(h.peek()?.description).toBe('A code editor with an error panel.')
  })

  it('without the OCR dep (Windows), behavior is byte-identical to before: VLM only', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(1)
    expect(h.peek()?.description).toBe('A code editor with an error panel.')
  })

  it('OCR results still respect the screen-hash dedupe (unchanged screen re-uses the extract)', async () => {
    const h = makeHarness({ withOcr: true })
    h.state.ocrText = "Text visible on the user's screen (OCR extract, top to bottom):\nSame content"
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.ocrCalls()).toBe(1)
    h.advance(3000)
    await h.sp._test.describeForWindow('w1')
    expect(h.ocrCalls()).toBe(1) // unchanged hash: stamp refreshed, no second OCR
  })
})

describe('createScreenPreprocess — OCR available without the local LLM (Qwen not enabled/provisioned)', () => {
  it('localReady=false + OCR present + OCR returns text: engine is eligible, caches the OCR extract, ' +
    'never calls the VLM endpoint or spins up the local runtime', async () => {
    const h = makeHarness({ withOcr: true, localReady: false })
    h.state.ocrText = "Text visible on the user's screen (OCR extract, top to bottom):\nQ3 pipeline review"
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true) // eligible on OCR alone, despite localReady=false
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.ocrCalls()).toBe(1)
    expect(h.peek()?.description).toContain('Q3 pipeline review')
    expect(h.fetchCalls()).toBe(0) // VLM never called
    expect(h.ensureStarted).not.toHaveBeenCalled() // local runtime never spun up
  })

  it('localReady=false + OCR present + OCR returns null: caches nothing, no fetch, no crash', async () => {
    const h = makeHarness({ withOcr: true, localReady: false })
    h.state.ocrText = null
    h.sp.refresh()
    h.setWindow('w1')
    await expect(h.sp._test.describeForWindow('w1')).resolves.toBeUndefined()
    expect(h.ocrCalls()).toBe(1)
    expect(h.peek()).toBeNull() // nothing cached
    expect(h.fetchCalls()).toBe(0) // no VLM fallback attempted
    expect(h.ensureStarted).not.toHaveBeenCalled()
  })

  it('localReady=false + no OCR dep (Windows): engine stays ineligible, does nothing', async () => {
    const h = makeHarness({ localReady: false }) // withOcr omitted → extractScreenText undefined
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.fetchCalls()).toBe(0)
    expect(h.peek()).toBeNull()
  })

  it('localReady=true + OCR present: unchanged OCR-first-then-VLM behavior still holds', async () => {
    const h = makeHarness({ withOcr: true, localReady: true })
    h.state.ocrText = null // text-poor screen → falls through to VLM
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.ocrCalls()).toBe(1)
    expect(h.fetchCalls()).toBe(1) // VLM fallback still runs when the runtime is ready
    expect(h.peek()?.description).toBe('A code editor with an error panel.')
  })
})

/**
 * MQA-179 — "can the background reader run?" used to be answered twice: once by the engine's own
 * eligible() and once by an independent expression in index.ts that drives the Settings copy. canRun()
 * is now the single authority both sides read.
 */
describe('createScreenPreprocess — one authority for "can this run" (MQA-179)', () => {
  it('MQA-179 — canRun() is the engine gate itself: true on OCR alone, with no local model (macOS)', () => {
    const h = makeHarness({ withOcr: true, localReady: false })
    expect(h.sp.canRun()).toBe(true)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true) // and the lifecycle agrees with the flag Settings renders
  })

  it('MQA-179 — canRun() is false without a session, so a signed-out app never claims the reader is on', () => {
    const h = makeHarness({ authorized: false })
    expect(h.sp.canRun()).toBe(false)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
  })
})

/**
 * MQA-209 — MQA-178 armed this engine at boot. On macOS the first capture is also the permission
 * request: `getScreenshot()` reaches desktopCapturer while the Screen Recording grant is
 * `not-determined` precisely so the system dialog appears (index.ts, captureScreenshotOnce). An engine
 * armed at boot therefore pops an unexplained TCC prompt seconds after launch — the exact pop-up the
 * neighbouring `probeScreenCapture` boot step is win32-gated to avoid. The grant is part of eligibility
 * now, so the boot path stays silent until the user has granted, and MQA-178 still holds once they have.
 */
describe('createScreenPreprocess — the boot arm must not raise the macOS TCC prompt (MQA-209)', () => {
  it('MQA-209 — darwin without the Screen Recording grant: nothing starts and nothing captures', async () => {
    const h = makeHarness({ withOcr: true, screenCaptureGranted: false })
    expect(h.sp.canRun()).toBe(false) // …and Settings reads "not running", which is the truth
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(0) // no capture => nothing that could raise the system permission dialog
    expect(h.peek()).toBeNull()
  })

  it('MQA-209 — darwin WITH the grant: the engine still arms at boot and describes (MQA-178 intact)', async () => {
    const h = makeHarness({ withOcr: true, screenCaptureGranted: true })
    h.state.ocrText = 'Inbox — 3 unread'
    expect(h.sp.canRun()).toBe(true)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(1)
    expect(h.sp.currentFreshContext()?.description).toBe('Inbox — 3 unread')
  })

  it('MQA-209 — a grant that lands mid-session arms the engine on the next reconcile', () => {
    const h = makeHarness({ withOcr: true, screenCaptureGranted: false })
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    h.state.screenCaptureGranted = true // onboarding's permissionsRequestUpfront just obtained it
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true) // no relaunch needed — that would be MQA-178 all over again
  })

  it('M2-0044 — Windows denied screen capture keeps the background loop inert: shots()===0', async () => {
    const h = makeHarness({ screenCaptureGranted: false, platform: 'win32' })
    expect(h.sp.canRun()).toBe(false)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(0)
    expect(h.peek()).toBeNull()
  })

  it('M2-0044 — a Windows grant that lands mid-session arms the engine on the next reconcile', async () => {
    const h = makeHarness({ screenCaptureGranted: false, platform: 'win32' })
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    h.state.screenCaptureGranted = true
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(1)
  })

  it('M2-0044 — platforms without a capture gate still arm when the other dependencies are ready', async () => {
    const h = makeHarness({ screenCaptureGranted: undefined, platform: 'linux' })
    expect(h.sp.canRun()).toBe(true)
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(true)
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(1)
  })
})

/**
 * MQA-181 — every invalidation this cache has (drop on focus change, refuse on window mismatch) is fed by
 * the foreground watcher. When the watcher dies the guards go quiet instead of failing closed, and the
 * engine keeps serving the description of the window the user already left.
 */
describe('createScreenPreprocess — a dead window signal must fail closed (MQA-181)', () => {
  it('MQA-181 — a watcher that dies mid-session stops the cache being served, instead of answering about the window the user just left', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.sp.currentFreshContext()?.description).toBe('A code editor with an error panel.')

    // The producer is killed (AppLocker/WDAC blocks Add-Type, EDR kills the spawn, restart budget spent).
    // No focus event will ever arrive again, so nothing can drop this entry when the user alt-tabs.
    h.state.watcherHealthy = false

    expect(h.sp.currentFreshContext()).toBeNull()
    // …and it is dropped, not merely hidden: a later health blip must not resurrect a stale screen.
    h.state.watcherHealthy = true
    expect(h.sp.currentFreshContext()).toBeNull()
  })

  it('MQA-181 — with no window signal at all the engine refuses to start rather than run blind', () => {
    const h = makeHarness({ watcherHealthy: false }) // linux, or a mac install missing the bundled helper
    h.sp.refresh()
    expect(h.sp.isActive()).toBe(false)
    expect(h.sp.canRun()).toBe(false) // and Settings reads "not running" instead of "on"
  })

  it('MQA-181 — a describe keyed to a blank window id is never committed', async () => {
    // The refresh tick used to pass `activeWindowId() ?? ''`, and the commit guard waved a null window
    // through — so entries landed under a falsy windowId that the read-side guard can never match.
    const h = makeHarness()
    h.sp.refresh() // watcher alive, but it has not reported a window yet
    await h.sp._test.describeForWindow('')
    expect(h.peek()).toBeNull()
  })
})

/**
 * MQA-183 — the frame is captured from the display under the CURSOR, but cached keyed only by the
 * foreground window. Alt-tab to a window on another monitor and the cursor stays put: the entry then
 * describes a monitor the user is not looking at, and both guards pass.
 */
describe('createScreenPreprocess — the description is bound to the display it came from (MQA-183)', () => {
  it('MQA-183 — serves null once the user is looking at a different monitor than the one described', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.dispId = 2 // pointer was resting over monitor 2 when the tick fired
    h.state.currentDisplayId = 2
    await h.sp._test.describeForWindow('w1')
    expect(h.sp.currentFreshContext()).not.toBeNull()

    h.state.currentDisplayId = 1 // pointer back on the monitor the focused window is actually on
    expect(h.sp.currentFreshContext()).toBeNull()
  })

  it('MQA-183 — a frame main already flagged as the wrong monitor is never cached at all', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.displayMismatch = true
    await h.sp._test.describeForWindow('w1')
    expect(h.peek()).toBeNull()
    expect(h.fetchCalls()).toBe(0) // and no inference is spent describing it
  })
})

/**
 * M2-0429 — a background capture that keeps failing used to be retried on every 6 s tick, each one a fresh
 * capture.failed audit line (thousands a day). It now backs off exponentially and latches after 5 permission
 * failures, with one screen.preprocess.suspended audit per streak.
 */
describe('createScreenPreprocess — failing captures back off instead of storming (M2-0429)', () => {
  const PERMISSION_OFF =
    'Screen Recording permission is off for Métis. Enable it in System Settings → Privacy & Security → Screen Recording, then restart Métis.'

  it('100 ticks of a denied capture make at most 5 attempts and one suspended audit', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.captureError = PERMISSION_OFF
    for (let i = 0; i < 100; i++) {
      await h.sp._test.describeForWindow('w1')
      h.advance(6_000)
    }
    expect(h.shots()).toBe(5)
    const suspended = h.audits.filter((a) => a.event === 'screen.preprocess.suspended')
    expect(suspended).toEqual([
      { event: 'screen.preprocess.suspended', data: { failures: 5, reason: 'permission', latched: true } }
    ])
  })

  it('a success resets the streak, so the next failure is retried after 6 s again', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.captureError = PERMISSION_OFF
    await h.sp._test.describeForWindow('w1')
    h.advance(6_000)
    h.state.captureError = null
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(2)
    h.state.captureError = PERMISSION_OFF
    h.advance(6_000)
    await h.sp._test.describeForWindow('w1')
    h.advance(6_000)
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(4)
  })

  it('a settings change clears the latch; a refresh that changes nothing it reads does not', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.captureError = PERMISSION_OFF
    for (let i = 0; i < 20; i++) {
      await h.sp._test.describeForWindow('w1')
      h.advance(700_000)
    }
    expect(h.shots()).toBe(5)
    h.sp.refresh() // e.g. an overlay-position write: nothing this engine reads changed
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(5)
    h.state.backgroundScreenContext = false
    h.sp.refresh()
    h.state.backgroundScreenContext = true
    h.sp.refresh()
    h.setWindow('w1')
    await h.sp._test.describeForWindow('w1')
    expect(h.shots()).toBe(6)
  })

  it('Private View is a deliberate block, never counted as a failure', async () => {
    const h = makeHarness()
    h.sp.refresh()
    h.setWindow('w1')
    h.state.captureError = 'Private View is on — screen capture is blocked. Turn it off to let Métis see your screen.'
    for (let i = 0; i < 10; i++) {
      await h.sp._test.describeForWindow('w1')
      h.advance(6_000)
    }
    expect(h.shots()).toBe(10)
    expect(h.audits.some((a) => a.event === 'screen.preprocess.suspended')).toBe(false)
  })
})
