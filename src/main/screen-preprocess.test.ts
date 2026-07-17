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
  /** Inject the optional OCR dep (mac path). ocrText/ocrThrow on state drive its behavior per test. */
  withOcr?: boolean
}) {
  let clock = 1_000_000
  const state = {
    backgroundScreenContext: init?.backgroundScreenContext ?? true,
    localReady: init?.localReady ?? true,
    privateView: init?.privateView ?? false,
    activeStreams: init?.activeStreams ?? 0,
    image: 'IMG_A',
    describeBody: 'A code editor with an error panel.' as string | null,
    ocrText: null as string | null,
    ocrThrow: false
  }
  let ocrCalls = 0
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

  const deps: ScreenPreprocessDeps = {
    getScreenshot: async () => ({ image: state.image, width: 1280, height: 800, capturedAt: clock }),
    getSettings: () => ({
      backgroundScreenContext: state.backgroundScreenContext,
      localLlm: { enabled: true, modelId: 'qwen3.5-0.8b' }
    }),
    localReady: () => state.localReady,
    privateViewOn: () => state.privateView,
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
      watcher = { stop: vi.fn(), current: () => currentWin }
      return watcher
    },
    extractScreenText: init?.withOcr
      ? async () => {
          ocrCalls++
          if (state.ocrThrow) throw new Error('helper died')
          return state.ocrText
        }
      : undefined,
    fetchImpl,
    now: () => clock,
    log: () => {}
  }

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
    fetchCalls: () => fetchCalls,
    ocrCalls: () => ocrCalls,
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
