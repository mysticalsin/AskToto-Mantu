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

describe('useAsk completion and cancellation ownership', () => {
  let toto: TotoStub

  beforeEach(() => {
    host.__reset()
    toto = installTotoStub()
  })

  it('settles a rejected start IPC as incomplete without exposing raw transport errors', async () => {
    const rejected = Promise.reject(new Error('Synthetic private transport detail'))
    void rejected.catch(() => undefined) // keep the RED focused on lifecycle rather than unhandled rejection
    toto.ask.mockReturnValueOnce(rejected)
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    toto.__fireDelta({ id, text: 'Current partial ' })
    toto.__fireDelta({ id, text: 'notes' }) // drain the pending frame too, not only the first token
    await host.__settle()
    expect(view.result.answer).toMatchObject({
      id, text: 'Current partial notes', completion: 'incomplete', streaming: false,
      error: 'Could not start the response. Please try again.'
    })
    expect(JSON.stringify(view.result.answer)).not.toContain('private transport detail')
  })

  it.each(['replace', 'clear', 'cancel', 'done'] as const)('ignores a late start rejection after %s', async (action) => {
    let reject!: (reason: Error) => void
    const pending = new Promise<void>((_resolve, fail) => { reject = fail })
    void pending.catch(() => undefined)
    toto.ask.mockReturnValueOnce(pending)
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    toto.__fireDelta({ id, text: 'Original notes' })
    if (action === 'replace') view.result.run({ mode: 'answer' })
    else if (action === 'clear') view.result.clear()
    else if (action === 'cancel') view.result.cancel()
    else toto.__fireDone({ id })
    await host.__settle()
    const expected = view.result.answer
    reject(new Error('Late start rejection'))
    await host.__settle()
    expect(view.result.answer).toEqual(expected)
  })

  it('marks a new run pending and only its matching done event complete', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap', prompt: 'current notes' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id, completion: 'pending', streaming: true, error: null })
    toto.__fireDone({ id: 'another-request' })
    await host.__settle()
    expect(view.result.answer?.completion).toBe('pending')
    toto.__fireDelta({ id, text: 'Completed notes' })
    toto.__fireDone({ id })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id, text: 'Completed notes', completion: 'complete', streaming: false })
  })

  it('drains the current pending frame before marking an error incomplete', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'summary' })
    await host.__settle()
    toto.__fireDelta({ id, text: 'Partial ' })
    toto.__fireDelta({ id, text: 'buffered notes' })
    toto.__fireError({ id, message: 'The remote host aborted the response.' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({
      id, text: 'Partial buffered notes', completion: 'incomplete', streaming: false,
      error: 'The remote host aborted the response.'
    })
  })

  it('marks a local failure incomplete and resets its error and completion on the next run', async () => {
    const view = renderAsk()
    const failed = view.result.fail('No provider available', 'Setup')
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id: failed, completion: 'incomplete', error: 'No provider available' })
    const id = view.result.run({ mode: 'answer' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id, completion: 'pending', error: null })
    toto.__fireDone({ id })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id, completion: 'complete', error: null, text: '' })
  })

  it('returns the current buffered cancellation snapshot synchronously and rejects IPC reentrancy', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    await host.__settle()
    toto.__fireDelta({ id, text: 'Current ' })
    toto.__fireDelta({ id, text: 'unpainted tail' })
    toto.cancel.mockImplementation(() => {
      toto.__fireDelta({ id, text: ' LATE' })
      toto.__fireMeta({ id, provider: 'anthropic', tier: 'deep' })
      toto.__fireDone({ id })
      toto.__fireError({ id, message: 'Late error' })
      return Promise.resolve()
    })
    const snapshot = view.result.cancel()
    expect(snapshot).toMatchObject({ id, text: 'Current unpainted tail', completion: 'incomplete', streaming: false, error: null })
    await host.__settle()
    expect(view.result.answer).toEqual(snapshot)
    expect(view.result.answer?.provider).toBeUndefined()
    toto.__fireDelta({ id, text: ' STILL LATE' })
    toto.__fireMeta({ id, provider: 'anthropic', tier: 'deep' })
    toto.__fireDone({ id })
    toto.__fireError({ id, message: 'Still late error' })
    await host.__settle()
    expect(view.result.answer).toEqual(snapshot)
  })

  it.each(['recap', 'summary'] as const)('does not return carried previous-answer text when %s is cancelled before output', async (mode) => {
    const view = renderAsk()
    const previous = view.result.run({ mode: 'answer' })
    await host.__settle()
    toto.__fireDelta({ id: previous, text: 'Unrelated previous answer' })
    toto.__fireDone({ id: previous })
    await host.__settle()
    const id = view.result.run({ mode })
    const snapshot = view.result.cancel()
    expect(snapshot).toMatchObject({ id, text: '', completion: 'incomplete', streaming: false })
    await host.__settle()
    expect(view.result.answer).toEqual(snapshot)
  })

  it('preserves ordinary answer carry-over when cancelled before new output', async () => {
    const view = renderAsk()
    const previous = view.result.run({ mode: 'answer' })
    await host.__settle()
    toto.__fireDelta({ id: previous, text: 'Previous answer stays visible' })
    toto.__fireDone({ id: previous })
    await host.__settle()
    const id = view.result.run({ mode: 'answer' })
    const snapshot = view.result.cancel()
    expect(snapshot).toMatchObject({ id, text: 'Previous answer stays visible', completion: 'incomplete' })
    await host.__settle()
    expect(view.result.answer).toEqual(snapshot)
  })

  it.each(['done', 'error', 'cancel'] as const)('preserves fast first-mount tokens when %s arrives before the first paint', async (terminal) => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    toto.__fireDelta({ id, text: 'Fast ' })
    toto.__fireDelta({ id, text: 'current notes' })
    if (terminal === 'done') toto.__fireDone({ id })
    else if (terminal === 'error') toto.__fireError({ id, message: 'Interrupted' })
    else expect(view.result.cancel()).toMatchObject({ id, text: 'Fast current notes', completion: 'incomplete' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({
      id, text: 'Fast current notes', streaming: false,
      completion: terminal === 'done' ? 'complete' : 'incomplete'
    })
  })

  it('clear invalidates before IPC and stays empty after same-stack run and cancellation', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    toto.__fireDelta({ id, text: 'Pending notes' })
    toto.cancel.mockImplementation(() => {
      toto.__fireDelta({ id, text: 'Late notes' })
      toto.__fireMeta({ id, provider: 'anthropic', tier: 'deep' })
      toto.__fireError({ id, message: 'Late error' })
      toto.__fireDone({ id })
      return Promise.resolve()
    })
    view.result.clear()
    expect(view.result.cancel()).toBeNull()
    await host.__settle()
    expect(view.result.answer).toBeNull()
  })

  it('returns an empty new-request cancellation snapshot before paint and cannot resurrect it after clear', async () => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap', prompt: 'current meeting' })
    const snapshot = view.result.cancel()
    expect(snapshot).toMatchObject({ id, text: '', completion: 'incomplete', streaming: false, prompt: 'current meeting' })
    view.result.clear()
    expect(view.result.cancel()).toBeNull()
    toto.__fireDelta({ id, text: 'Late text' })
    toto.__fireDone({ id })
    await host.__settle()
    expect(view.result.answer).toBeNull()
    expect(snapshot).toMatchObject({ id, text: '', completion: 'incomplete' })
  })

  it('late events from a replaced request cannot affect its replacement, even during cancellation IPC', async () => {
    const view = renderAsk()
    const old = view.result.run({ mode: 'recap' })
    await host.__settle()
    toto.__fireDelta({ id: old, text: 'Old notes' })
    toto.cancel.mockImplementation(() => {
      toto.__fireDelta({ id: old, text: ' contaminating tail' })
      toto.__fireDone({ id: old })
      return Promise.resolve()
    })
    const id = view.result.run({ mode: 'recap' })
    toto.__fireDelta({ id, text: 'Replacement notes' })
    toto.__fireError({ id: old, message: 'Old failure' })
    toto.__fireMeta({ id: old, provider: 'anthropic', tier: 'deep' })
    await host.__settle()
    expect(view.result.answer).toMatchObject({ id, text: 'Replacement notes', completion: 'pending', error: null })
    expect(view.result.answer?.provider).toBeUndefined()
  })

  it.each(['done', 'error'] as const)('does not change a settled %s outcome on later cancel or duplicate callbacks', async (terminal) => {
    const view = renderAsk()
    const id = view.result.run({ mode: 'recap' })
    await host.__settle()
    toto.__fireDelta({ id, text: 'Current notes' })
    if (terminal === 'done') toto.__fireDone({ id })
    else toto.__fireError({ id, message: 'Interrupted' })
    await host.__settle()
    const settled = view.result.answer
    expect(view.result.cancel()).toEqual(settled)
    toto.__fireDelta({ id, text: ' LATE' })
    toto.__fireMeta({ id, provider: 'anthropic', tier: 'deep' })
    toto.__fireDone({ id })
    toto.__fireError({ id, message: 'Late failure' })
    await host.__settle()
    expect(view.result.answer).toEqual(settled)
    expect(toto.cancel).not.toHaveBeenCalled()
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
