import { describe, expect, it, vi } from 'vitest'
import { IDLE_WALKTHROUGH_VIEW, WALKTHROUGH_IPC, type WalkthroughView } from '../shared/walkthrough-view'
import { createWalkthroughPreloadApi } from './walkthrough'

const VIEW: WalkthroughView = {
  ...IDLE_WALKTHROUGH_VIEW,
  runId: 'r1',
  phase: 'awaiting',
  step: 1,
  stepCount: 2,
  instruction: 'Click Share.',
  status: 'Tell Métis when done.',
  canCheck: true,
  canStop: true
}

function fakeIpc(invokeResult: unknown = undefined) {
  const listeners = new Set<(event: unknown, payload: unknown) => void>()
  return {
    ipc: {
      on: vi.fn((_c: string, fn: (event: unknown, payload: unknown) => void) => void listeners.add(fn)),
      removeListener: vi.fn((_c: string, fn: (event: unknown, payload: unknown) => void) => void listeners.delete(fn)),
      invoke: vi.fn(async () => invokeResult)
    },
    push: (payload: unknown) => listeners.forEach((fn) => fn({}, payload)),
    listeners
  }
}

describe('walkthrough preload bridge (G45)', () => {
  it('current returns a validated view and idle for a malformed reply', async () => {
    expect(await createWalkthroughPreloadApi(fakeIpc(VIEW).ipc as never).walkthrough.current()).toEqual(VIEW)
    expect(
      await createWalkthroughPreloadApi(fakeIpc({ ...VIEW, extra: 1 }).ipc as never).walkthrough.current()
    ).toEqual(IDLE_WALKTHROUGH_VIEW)
  })

  it('act sends only the validated action and normalises the reply to {ok}', async () => {
    const { ipc } = fakeIpc({ ok: true })
    const api = createWalkthroughPreloadApi(ipc as never).walkthrough
    expect(await api.act('pause')).toEqual({ ok: true })
    expect(ipc.invoke).toHaveBeenLastCalledWith(WALKTHROUGH_IPC.act, { action: 'pause' })
    expect(await api.act('start' as never)).toEqual({ ok: false })
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(await createWalkthroughPreloadApi(fakeIpc('weird').ipc as never).walkthrough.act('stop')).toEqual({
      ok: false
    })
  })

  it('onView delivers valid pushes, drops invalid ones, survives a throwing listener and unsubscribes', () => {
    const { ipc, push, listeners } = fakeIpc()
    const seen: WalkthroughView[] = []
    const off = createWalkthroughPreloadApi(ipc as never).walkthrough.onView((v) => void seen.push(v))
    push(VIEW)
    push({ ...VIEW, windowTitle: 'leak' })
    push('nope')
    expect(seen).toEqual([VIEW])
    createWalkthroughPreloadApi(ipc as never).walkthrough.onView(() => {
      throw new Error('boom')
    })
    expect(() => push(VIEW)).not.toThrow()
    off()
    expect(ipc.removeListener).toHaveBeenCalledWith(WALKTHROUGH_IPC.view, expect.any(Function))
    expect(listeners.size).toBe(1)
  })
})
