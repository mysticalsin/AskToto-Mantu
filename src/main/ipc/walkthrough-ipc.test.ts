import { describe, expect, it, vi } from 'vitest'
import { IDLE_WALKTHROUGH_VIEW, WALKTHROUGH_IPC } from '@shared/walkthrough-view'
import { createWalkthroughOwnerPush, registerWalkthroughIpc } from './walkthrough-ipc'

function setup(enabled = true, status = 'paused') {
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const assertMainWindow = vi.fn((event: unknown) => {
    if ((event as { trusted?: boolean }).trusted !== true) throw new Error('untrusted sender')
  })
  const surface = {
    enabled: vi.fn(() => enabled),
    view: vi.fn(() => IDLE_WALKTHROUGH_VIEW),
    handle: vi.fn(async () => ({ status }))
  }
  registerWalkthroughIpc(
    {
      handle: (channel: string, fn: (event: unknown, payload?: unknown) => unknown) => void handlers.set(channel, fn)
    } as never,
    assertMainWindow as never,
    surface
  )
  const call = (channel: string, payload?: unknown, trusted = true) => handlers.get(channel)?.({ trusted }, payload)
  return { handlers, call, surface }
}

describe('walkthrough IPC (G45)', () => {
  it('registers exactly current and act: nothing that starts a walkthrough', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([WALKTHROUGH_IPC.current, WALKTHROUGH_IPC.act].sort())
  })

  it('refuses a sender that is not the main window before touching the runtime', async () => {
    const { call, surface } = setup()
    expect(() => call(WALKTHROUGH_IPC.current, undefined, false)).toThrow('untrusted sender')
    await expect(Promise.resolve().then(() => call(WALKTHROUGH_IPC.act, { action: 'stop' }, false))).rejects.toThrow(
      'untrusted sender'
    )
    expect(surface.view).not.toHaveBeenCalled()
    expect(surface.handle).not.toHaveBeenCalled()
  })

  it('current returns the runtime view', () => {
    expect(setup().call(WALKTHROUGH_IPC.current)).toEqual(IDLE_WALKTHROUGH_VIEW)
  })

  it.each(['check', 'pause', 'resume', 'stop'] as const)('maps the %s action to the runtime intent', async (action) => {
    const { call, surface } = setup()
    expect(await call(WALKTHROUGH_IPC.act, { action })).toEqual({ ok: true })
    expect(surface.handle).toHaveBeenCalledWith({ kind: action })
  })

  it.each([
    undefined,
    null,
    'stop',
    { action: 'start' },
    { action: 'stop', goal: 'x' },
    { action: 'check', extra: 1 }
  ])('refuses a malformed or start-shaped payload %j', async (payload) => {
    const { call, surface } = setup()
    expect(await call(WALKTHROUGH_IPC.act, payload)).toEqual({ ok: false })
    expect(surface.handle).not.toHaveBeenCalled()
  })

  it('with the feature off (release default) an action is refused and does nothing', async () => {
    const { call, surface } = setup(false)
    expect(await call(WALKTHROUGH_IPC.act, { action: 'stop' })).toEqual({ ok: false })
    expect(surface.handle).not.toHaveBeenCalled()
  })

  it('reports ok false when the runtime ignores or refuses the action, and when it throws', async () => {
    expect(await setup(true, 'ignored').call(WALKTHROUGH_IPC.act, { action: 'pause' })).toEqual({ ok: false })
    expect(await setup(true, 'no_owner').call(WALKTHROUGH_IPC.act, { action: 'pause' })).toEqual({ ok: false })
    const { call, surface } = setup()
    surface.handle.mockRejectedValueOnce(new Error('boom'))
    expect(await call(WALKTHROUGH_IPC.act, { action: 'pause' })).toEqual({ ok: false })
  })
})

describe('walkthrough owner push (G45)', () => {
  const win = (id: number, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { id, send: vi.fn() }
  })

  it('sends a validated view to the live owner window only', () => {
    const owner = win(7)
    createWalkthroughOwnerPush({ window: () => owner, ownerWebContentsId: () => 7 })(IDLE_WALKTHROUGH_VIEW)
    expect(owner.webContents.send).toHaveBeenCalledWith(WALKTHROUGH_IPC.view, IDLE_WALKTHROUGH_VIEW)
  })

  it('sends nothing to another window, a destroyed one, or when there is no owner', () => {
    const other = win(8)
    createWalkthroughOwnerPush({ window: () => other, ownerWebContentsId: () => 7 })(IDLE_WALKTHROUGH_VIEW)
    const dead = win(7, true)
    createWalkthroughOwnerPush({ window: () => dead, ownerWebContentsId: () => 7 })(IDLE_WALKTHROUGH_VIEW)
    createWalkthroughOwnerPush({ window: () => other, ownerWebContentsId: () => null })(IDLE_WALKTHROUGH_VIEW)
    createWalkthroughOwnerPush({ window: () => null, ownerWebContentsId: () => 7 })(IDLE_WALKTHROUGH_VIEW)
    expect(other.webContents.send).not.toHaveBeenCalled()
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('never sends a view that fails the schema', () => {
    const owner = win(7)
    createWalkthroughOwnerPush({ window: () => owner, ownerWebContentsId: () => 7 })({
      ...IDLE_WALKTHROUGH_VIEW,
      windowTitle: 'leak'
    } as never)
    expect(owner.webContents.send).not.toHaveBeenCalled()
  })
})
