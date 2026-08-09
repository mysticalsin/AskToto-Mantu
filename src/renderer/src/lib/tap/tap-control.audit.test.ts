/**
 * MQA-084 — Desk Tap Control must not tear down and re-acquire the microphone on every settings
 * refresh, and must not orphan a capturing keydown listener when the capture fails.
 *
 * Two independent defects, one file:
 *   (a) CHURN — the arm effect depended on the `profile` OBJECT. `settings.tapControl.profile` is a
 *       nested object that comes fresh over IPC on every settings read (window focus, every patch,
 *       including the unattended fallback patches a live meeting writes), so its identity changed
 *       constantly while its CONTENT did not: getUserMedia + AudioContext + addModule ran again every
 *       time, dropping the taps in each re-acquisition window. `sensitivity` was in the same deps even
 *       though the session exposes setSensitivity for in-place adjustment.
 *   (b) LEAK — `window.addEventListener('keydown', onKey, true)` is registered BEFORE the awaited
 *       capture, and stop() (only reachable via a resolved session) is its only release path, so every
 *       rejected acquisition left one more capturing listener on window forever.
 *
 * There is no jsdom / @testing-library harness in this repo (vitest runs the `node` environment, see
 * vitest.config.ts) and adding one is out of scope, so the hook is driven through a minimal hooks host
 * — useRef plus a dependency-array-aware useEffect with React's cleanup-then-effect commit order. That
 * is the whole surface useTapControl touches; the Web Audio stack below is faked at the same depth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FEATURE_DIM } from './features'
import type { TapProfile } from './classify'

type EffectFn = () => (() => void) | void

/** Built in vi.hoisted because the vi.mock('react') factory below and the test body need the SAME
 *  instance, and mock factories are hoisted above regular declarations. */
const host = vi.hoisted(() => {
  type RefSlot = { kind: 'ref'; ref: { current: unknown } }
  type EffectSlot = {
    kind: 'effect'
    fn: () => (() => void) | void
    deps?: unknown[]
    cleanup?: (() => void) | void
    dirty: boolean
  }
  let slots: Array<RefSlot | EffectSlot> = []
  let cursor = 0
  const sameDeps = (a?: unknown[], b?: unknown[]): boolean =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  return {
    useRef<T>(initial: T): { current: T } {
      const i = cursor++
      if (!slots[i]) slots[i] = { kind: 'ref', ref: { current: initial } }
      return (slots[i] as RefSlot).ref as { current: T }
    },
    useEffect(fn: () => (() => void) | void, deps?: unknown[]): void {
      const i = cursor++
      const prev = slots[i] as EffectSlot | undefined
      if (!prev) {
        slots[i] = { kind: 'effect', fn, deps, dirty: true }
        return
      }
      prev.fn = fn
      if (!sameDeps(prev.deps, deps)) {
        prev.deps = deps
        prev.dirty = true
      }
    },
    /** React's commit order: every changed effect's cleanup first, then every changed effect. */
    commit(): void {
      const changed = slots.filter((s): s is EffectSlot => s.kind === 'effect' && s.dirty)
      for (const s of changed) {
        s.cleanup?.()
        s.cleanup = undefined
      }
      for (const s of changed) {
        s.dirty = false
        s.cleanup = s.fn()
      }
    },
    beginRender(): void {
      cursor = 0
    },
    unmount(): void {
      for (const s of slots) if (s.kind === 'effect') s.cleanup?.()
      slots = []
      cursor = 0
    }
  }
})

vi.mock('react', () => ({
  useRef: <T>(initial: T) => host.useRef(initial),
  useEffect: (fn: EffectFn, deps?: unknown[]) => host.useEffect(fn, deps)
}))

// Imported after the mock so the hook binds to the host above.
const { startTapControl, useTapControl } = await import('./tap-control')
type UseArgs = Parameters<typeof useTapControl>[0]

// --- fakes -------------------------------------------------------------------------------------

let keyListeners: Array<{ type: string; fn: unknown; capture: unknown }> = []
let getUserMedia = vi.fn()
let trackStops = 0
let contextCloses = 0
let workletNodes = 0
let sensitivityPosts: number[] = []

class FakeAudioContext {
  sampleRate = 48000
  destination = {}
  audioWorklet = { addModule: async (): Promise<void> => {} }
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => {}, disconnect: () => {} }
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }
  }
  async close(): Promise<void> {
    contextCloses++
  }
}

class FakeAudioWorkletNode {
  port = {
    onmessage: null as unknown,
    postMessage: (m: { sensitivity?: number }): void => {
      if (typeof m?.sensitivity === 'number') sensitivityPosts.push(m.sensitivity)
    }
  }
  constructor() {
    workletNodes++
  }
  connect(): void {}
  disconnect(): void {}
}

const okStream = (): unknown => ({
  getTracks: () => [
    {
      stop: (): void => {
        trackStops++
      }
    }
  ]
})

function makeProfile(over: Partial<TapProfile> = {}): TapProfile {
  return {
    version: 1,
    sampleRate: 48000,
    micDeviceId: 'default',
    mean: new Array(FEATURE_DIM).fill(0),
    std: new Array(FEATURE_DIM).fill(1),
    zones: [{ name: 'Zone 1', centroid: new Array(FEATURE_DIM).fill(0) }],
    negatives: [],
    dAccept: 3,
    levelRange: { min: -4, max: -1 },
    createdAt: 1_700_000_000_000,
    ...over
  }
}

/** What a settings refresh actually delivers: an equal profile with a brand-new object identity. */
const overIpc = (p: TapProfile): TapProfile => JSON.parse(JSON.stringify(p)) as TapProfile

function render(args: UseArgs): void {
  host.beginRender()
  useTapControl(args)
  host.commit()
}

/** Let startTapCapture's getUserMedia + addModule promise chain resolve. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  keyListeners = []
  trackStops = 0
  contextCloses = 0
  workletNodes = 0
  sensitivityPosts = []
  getUserMedia = vi.fn(async () => okStream())
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: unknown, capture: unknown) => {
      keyListeners.push({ type, fn, capture })
    },
    removeEventListener: (type: string, fn: unknown, capture: unknown) => {
      const i = keyListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture)
      if (i >= 0) keyListeners.splice(i, 1)
    }
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: (c: unknown) => getUserMedia(c) } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)
})

afterEach(() => {
  host.unmount()
  vi.unstubAllGlobals()
})

describe('MQA-084 — startTapControl releases its keydown listener when the capture fails', () => {
  it('leaves no capturing keydown listener behind after a rejected acquisition', async () => {
    getUserMedia = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })

    await expect(
      startTapControl({ profile: makeProfile(), sensitivity: 0.5, onEvent: () => {} })
    ).rejects.toThrow('NotAllowedError')

    expect(keyListeners.filter((l) => l.type === 'keydown')).toHaveLength(0)
  })

  it('does not accumulate one orphaned listener per failed arm', async () => {
    getUserMedia = vi.fn(async () => {
      throw new Error('NotReadableError')
    })

    for (let i = 0; i < 5; i++) {
      await startTapControl({ profile: makeProfile(), sensitivity: 0.5, onEvent: () => {} }).catch(
        () => {}
      )
    }

    expect(keyListeners.filter((l) => l.type === 'keydown')).toHaveLength(0)
  })

  it('still releases the listener through stop() on the success path', async () => {
    const s = await startTapControl({ profile: makeProfile(), sensitivity: 0.5, onEvent: () => {} })
    expect(keyListeners.filter((l) => l.type === 'keydown')).toHaveLength(1)

    s.stop()

    expect(keyListeners.filter((l) => l.type === 'keydown')).toHaveLength(0)
    expect(trackStops).toBe(1)
  })
})

describe('MQA-084 — useTapControl does not re-acquire the mic on settings churn', () => {
  it('keeps the same capture across settings refreshes that only change profile identity', async () => {
    const profile = makeProfile()
    const args: UseArgs = { active: true, profile, sensitivity: 0.5, onZone: () => {} }
    render(args)
    await settle()
    expect(getUserMedia).toHaveBeenCalledTimes(1)

    // Three window focuses / patches, each replacing `settings` with a fresh IPC object graph.
    for (let i = 0; i < 3; i++) {
      render({ ...args, profile: overIpc(profile) })
      await settle()
    }

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(workletNodes).toBe(1)
    expect(trackStops).toBe(0)
    expect(contextCloses).toBe(0)
  })

  it('pushes a sensitivity change into the open session instead of re-arming', async () => {
    const profile = makeProfile()
    const args: UseArgs = { active: true, profile, sensitivity: 0.5, onZone: () => {} }
    render(args)
    await settle()

    render({ ...args, profile: overIpc(profile), sensitivity: 0.8 })
    await settle()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(workletNodes).toBe(1)
    expect(trackStops).toBe(0)
    expect(sensitivityPosts).toEqual([0.5, 0.8])
  })

  it('still re-arms when the profile is genuinely recalibrated', async () => {
    const profile = makeProfile()
    const args: UseArgs = { active: true, profile, sensitivity: 0.5, onZone: () => {} }
    render(args)
    await settle()

    render({ ...args, profile: makeProfile({ createdAt: profile.createdAt + 60_000 }) })
    await settle()

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(trackStops).toBe(1)
    expect(contextCloses).toBe(1)
  })

  it('still tears the capture down when the feature is disarmed', async () => {
    const profile = makeProfile()
    const args: UseArgs = { active: true, profile, sensitivity: 0.5, onZone: () => {} }
    render(args)
    await settle()

    render({ ...args, active: false })
    await settle()

    expect(trackStops).toBe(1)
    expect(contextCloses).toBe(1)
    expect(keyListeners.filter((l) => l.type === 'keydown')).toHaveLength(0)
  })
})
