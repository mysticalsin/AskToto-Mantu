/**
 * state.useAsk.test.ts — regression test for the "follow-up answer concatenates onto the previous
 * answer" defect in useAsk's flush().
 *
 * Root cause: flush() read the LIVE `pendingReplaceRef.current` from INSIDE the setAnswer updater, then
 * reset the ref to false on the very next line, synchronously, right after calling setAnswer. Under React
 * 18's automatic batching, setState's updater function does not run synchronously at the call site — it
 * runs later, during the batched re-render (a microtask). By the time it actually ran, the ref had already
 * been flipped to false by the line that follows the setAnswer call, so the "replace" branch was
 * unreachable and every post-reset flush appended onto whatever text was already on screen instead of
 * replacing it — visible as turn 2 rendering as turn1Text + turn2Text (e.g. "OK" + "mango77" ->
 * "OKmango77").
 *
 * There is no jsdom/@testing-library/react-style render harness anywhere in this repo (vitest runs in the
 * `node` environment; see vitest.config.ts) and this fix is not addable as a new dependency. A naive
 * SYNCHRONOUS fake `setState` (an updater invoked immediately at the call site) would NOT reproduce this
 * bug at all -- the ordering bug only exists because the updater runs AFTER the ref mutation, which only
 * happens under deferred/batched scheduling. So this test drives the real useAsk() through a minimal,
 * purpose-built hooks host that mimics exactly that one aspect of React 18: setState calls are queued and
 * applied (their updater actually invoked) in a later microtask, not synchronously inside the call that
 * enqueued them. Every other hook (useRef/useCallback/useMemo/useEffect) is a straightforward, correct
 * (dependency-array-aware) stand-in -- no DOM, no React runtime, just enough to exercise the real
 * production code in src/renderer/src/state.ts under the timing model the bug actually depends on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamDelta, StreamDone, StreamError, StreamMeta } from '@shared/ipc'

type Cleanup = void | (() => void)

/** Minimal React hooks host with REAL microtask-deferred setState batching (see file header). Built via
 *  vi.hoisted because the vi.mock('react', ...) factory below and the test body both need this SAME
 *  instance, and vi.mock factories are hoisted above regular imports/const declarations. */
const host = vi.hoisted(() => {
  // vi.hoisted runs before imports, including the `vi.mock('react', ...)` factory below — the factory
  // and the test body both need the SAME host instance, so it's constructed here and reused by reference.
  let hooks: Array<Record<string, unknown>> = []
  let hookIndex = 0
  let pendingUpdates: Array<() => void> = []
  let flushScheduled = false
  let onSettled: () => void = () => {}

  function sameDepsInner(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false
    return a.every((v, i) => Object.is(v, b[i]))
  }
  function scheduleFlush(): void {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      const updates = pendingUpdates
      pendingUpdates = []
      for (const apply of updates) apply()
      onSettled()
    })
  }
  return {
    useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
      const i = hookIndex++
      if (!(i in hooks)) hooks[i] = { v: typeof initial === 'function' ? (initial as () => T)() : initial }
      const slot = hooks[i] as { v: T }
      const setter = (next: T | ((prev: T) => T)): void => {
        pendingUpdates.push(() => {
          slot.v = typeof next === 'function' ? (next as (prev: T) => T)(slot.v) : next
        })
        scheduleFlush()
      }
      return [slot.v, setter]
    },
    useRef<T>(initial: T): { current: T } {
      const i = hookIndex++
      if (!(i in hooks)) hooks[i] = { current: initial }
      return hooks[i] as { current: T }
    },
    useCallback<T>(fn: T, deps: unknown[]): T {
      const i = hookIndex++
      const slot = hooks[i] as { fn: T; deps: unknown[] } | undefined
      if (!slot || !sameDepsInner(slot.deps, deps)) {
        hooks[i] = { fn, deps }
        return fn
      }
      return slot.fn
    },
    useMemo<T>(factory: () => T, deps: unknown[]): T {
      const i = hookIndex++
      const slot = hooks[i] as { value: T; deps: unknown[] } | undefined
      if (!slot || !sameDepsInner(slot.deps, deps)) {
        const value = factory()
        hooks[i] = { value, deps }
        return value
      }
      return slot.value
    },
    useEffect(effect: () => Cleanup, deps: unknown[]): void {
      const i = hookIndex++
      const slot = hooks[i] as { deps: unknown[]; cleanup?: () => void } | undefined
      if (!slot || !sameDepsInner(slot.deps, deps)) {
        slot?.cleanup?.()
        const cleanup = effect()
        hooks[i] = { deps, cleanup: cleanup ?? undefined }
      }
    },
    startTransition(fn: () => void): void {
      fn()
    },
    __reset(): void {
      hooks = []
      hookIndex = 0
      pendingUpdates = []
      flushScheduled = false
      onSettled = () => {}
    },
    __resetIndexForRender(): void {
      hookIndex = 0
    },
    __setOnSettled(fn: () => void): void {
      onSettled = fn
    },
    async __settle(): Promise<void> {
      // Cross a real macrotask boundary first so a requestAnimationFrame-scheduled flush (every delta
      // after the first — see state.ts's onDelta handler) actually runs and enqueues its setState, then
      // drain microtasks so that queued update is applied and the render callback fires.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await Promise.resolve()
      await Promise.resolve()
    }
  }
})

vi.mock('react', () => ({
  useState: host.useState,
  useRef: host.useRef,
  useCallback: host.useCallback,
  useMemo: host.useMemo,
  useEffect: host.useEffect,
  startTransition: host.startTransition
}))

// Imported AFTER the mock is declared (vitest hoists vi.mock above imports) so useAsk picks up the fake
// 'react' host above instead of a real dispatcher-less call.
import { useAsk } from './state'

type TotoStub = {
  ask: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  onDelta: (cb: (d: StreamDelta) => void) => () => void
  onDone: (cb: (d: StreamDone) => void) => () => void
  onMeta: (cb: (d: unknown) => void) => () => void
  onError: (cb: (d: unknown) => void) => () => void
  __fireDelta: (d: StreamDelta) => void
  __fireDone: (d: StreamDone) => void
  __fireMeta: (m: StreamMeta) => void
  __fireError: (e: StreamError) => void
}

// state.ts batches every delta after the first via requestAnimationFrame, which node doesn't provide.
// Its own settle() only needs the flush to eventually run and land its setState in a microtask, so a
// setTimeout(0) stand-in is faithful enough here (this test isn't asserting anything about frame timing).
;(globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (
  cb
) => setTimeout(cb, 0) as unknown as number
;(globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = (id) =>
  clearTimeout(id)

function installTotoStub(): TotoStub {
  let deltaCb: ((d: StreamDelta) => void) | null = null
  let doneCb: ((d: StreamDone) => void) | null = null
  let metaCb: ((m: StreamMeta) => void) | null = null
  let errorCb: ((e: StreamError) => void) | null = null
  const stub: TotoStub = {
    ask: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    onDelta: (cb) => {
      deltaCb = cb
      return () => {
        deltaCb = null
      }
    },
    onDone: (cb) => {
      doneCb = cb
      return () => {
        doneCb = null
      }
    },
    onMeta: (cb) => {
      metaCb = cb as (m: StreamMeta) => void
      return () => {
        metaCb = null
      }
    },
    onError: (cb) => {
      errorCb = cb as (e: StreamError) => void
      return () => {
        errorCb = null
      }
    },
    __fireDelta: (d) => deltaCb?.(d),
    __fireDone: (d) => doneCb?.(d),
    __fireMeta: (m) => metaCb?.(m),
    __fireError: (e) => errorCb?.(e)
  }
  ;(globalThis as unknown as { window: { toto: TotoStub } }).window = { toto: stub }
  return stub
}

/** Drives useAsk() like a tiny renderHook: re-invokes it after every settled batch and exposes the latest result. */
function renderAsk(): { result: ReturnType<typeof useAsk> } {
  const box = { result: undefined as unknown as ReturnType<typeof useAsk> }
  const doRender = (): void => {
    host.__resetIndexForRender()
    box.result = useAsk()
  }
  host.__setOnSettled(doRender)
  doRender()
  return box as { result: ReturnType<typeof useAsk> }
}

describe('useAsk follow-up turns replace, never concatenate', () => {
  let toto: TotoStub

  beforeEach(() => {
    host.__reset()
    toto = installTotoStub()
  })

  it("a second ask's streamed text excludes the first answer's text", async () => {
    const view = renderAsk()

    // Turn 1: ask, stream "OK", complete.
    const id1 = view.result.run({ mode: 'ask', prompt: 'first question' })
    await host.__settle()
    toto.__fireDelta({ id: id1, text: 'OK' })
    await host.__settle()
    expect(view.result.answer?.text).toBe('OK')
    toto.__fireDone({ id: id1 })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id: id1, text: 'OK', streaming: false })

    // Turn 2: ask again. Per state.ts, the stale turn-1 text is deliberately kept on screen (under the
    // NEW id) until turn 2's first real chunk lands...
    const id2 = view.result.run({ mode: 'ask', prompt: 'second question' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id: id2, text: 'OK', streaming: true })

    // ...and that first chunk must REPLACE it, never append to it.
    toto.__fireDelta({ id: id2, text: 'mango77' })
    await host.__settle()
    expect(view.result.answer?.text).toBe('mango77')
    expect(view.result.answer?.text).not.toContain('OK')

    toto.__fireDone({ id: id2 })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id: id2, text: 'mango77', streaming: false })
  })

  it('handles a second multi-delta stream the same way after a longer first answer', async () => {
    const view = renderAsk()

    const id1 = view.result.run({ mode: 'ask', prompt: 'q1' })
    await host.__settle()
    toto.__fireDelta({ id: id1, text: 'first answer confirmed above.' })
    await host.__settle()
    toto.__fireDone({ id: id1 })
    await host.__settle()
    expect(view.result.answer?.text).toBe('first answer confirmed above.')

    const id2 = view.result.run({ mode: 'ask', prompt: 'q2' })
    await host.__settle()
    toto.__fireDelta({ id: id2, text: 'NO-' })
    await host.__settle()
    toto.__fireDelta({ id: id2, text: 'IDEA' })
    await host.__settle()

    expect(view.result.answer?.text).toBe('NO-IDEA')
    expect(view.result.answer?.text).not.toContain('confirmed above')
  })
})


// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// MQA-180 / MQA-182 — the "Viewed screen" trust badge must never outrun the data behind it.
//
// run() sets usedScreen OPTIMISTICALLY: on the screen fast path the renderer sends an INTENT flag only
// (wantsScreenContext), and MAIN decides at send time whether its on-device description still existed.
// Retry / "Go deeper" replay that flag verbatim minutes later — long after the description expired or
// Private View went on — so the renderer cannot be the authority on whether an answer saw the screen.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("MQA-180 — the screen badge follows main's verdict, not the renderer's intent", () => {
  let toto: TotoStub

  beforeEach(() => {
    host.__reset()
    toto = installTotoStub()
  })

  it('clears usedScreen when main reports the screen context was gone at send time', async () => {
    const view = renderAsk()
    const id = view.result.run({
      mode: 'answer',
      prompt: 'what am I looking at?',
      wantsScreenContext: true
    })
    await host.__settle()
    // Optimistic at run() time — all the renderer knows is that it ASKED for the screen fast path.
    expect(view.result.answer?.usedScreen).toBe(true)

    // Main injected nothing (stale/absent on-device description) and says so.
    toto.__fireMeta({ id, provider: 'anthropic', tier: 'base', usedScreen: false })
    await host.__settle()

    expect(view.result.answer?.usedScreen).toBe(false)
    expect(view.result.answer?.screenMissed).toBe(true)
  })

  it('confirms the badge when main did inject a fresh description', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'answer', prompt: 'what is this error?', wantsScreenContext: true })
    await host.__settle()
    toto.__fireMeta({ id, provider: 'anthropic', tier: 'base', usedScreen: true })
    await host.__settle()

    expect(view.result.answer?.usedScreen).toBe(true)
    expect(view.result.answer?.screenMissed).toBe(false)
  })

  it('leaves a real vision answer alone when main sends no screen verdict', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'vision', image: 'ZmFrZQ==', prompt: 'read this' })
    await host.__settle()
    // A vision ask carries the image itself, so main has no verdict to give — the renderer keeps its own.
    toto.__fireMeta({ id, provider: 'anthropic', tier: 'base' })
    await host.__settle()

    expect(view.result.answer?.usedScreen).toBe(true)
    expect(view.result.answer?.provider).toBe('anthropic')
  })
})

describe('live incomplete responses preserve buffered partial text', () => {
  it('drains the pending frame on error without retaining text from a previous request', async () => {
    host.__reset()
    const toto = installTotoStub()
    const view = renderAsk()
    const previous = view.result.run({ mode: 'recap', prompt: 'previous' })
    await host.__settle()
    toto.__fireDelta({ id: previous, text: 'Old completed notes' })
    toto.__fireDone({ id: previous })
    await host.__settle()

    const id = view.result.run({ mode: 'recap', prompt: 'current' })
    await host.__settle()
    toto.__fireDelta({ id, text: 'Current partial ' })
    toto.__fireDelta({ id, text: 'notes still buffered' })
    toto.__fireError({ id, message: 'Response incomplete. Try again.' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({
      id, text: 'Current partial notes still buffered', streaming: false,
      error: 'Response incomplete. Try again.'
    })
  })
})

describe('MQA-182 — a request that produced nothing stops claiming it viewed the screen', () => {
  let toto: TotoStub

  beforeEach(() => {
    host.__reset()
    toto = installTotoStub()
  })

  it('drops the badge when the ask is rejected before any output (Private View blocks the replay)', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'vision', image: 'ZmFrZQ==', prompt: 'what is on my screen?' })
    await host.__settle()
    expect(view.result.answer?.usedScreen).toBe(true)

    // Main refuses the stored frame at the IPC boundary once Private View is on — nothing was sent, so
    // there is no screen-grounded answer for the badge (or the Bar's freshness chip) to describe.
    toto.__fireError({
      id,
      message: 'Private View is on — screen capture is blocked. Turn it off to let Métis see your screen.'
    })
    await host.__settle()

    expect(view.result.answer?.error).toMatch(/Private View/)
    expect(view.result.answer?.text).toBe('')
    expect(view.result.answer?.usedScreen).toBe(false)
  })

  it('keeps the badge when the stream failed AFTER real output — that answer really did view the screen', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'vision', image: 'ZmFrZQ==', prompt: 'read this' })
    await host.__settle()
    toto.__fireDelta({ id, text: 'The screen shows a stack trace' })
    await host.__settle()
    toto.__fireError({ id, message: 'provider dropped the connection' })
    await host.__settle()

    expect(view.result.answer?.text).toBe('The screen shows a stack trace')
    expect(view.result.answer?.usedScreen).toBe(true)
  })
})
