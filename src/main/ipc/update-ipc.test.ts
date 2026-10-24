import { describe, expect, it, vi } from 'vitest'
import type { UpdateLifecycleState } from '@shared/update-lifecycle'
import { IPC } from '@shared/ipc'
import { UPDATE_LIFECYCLE_IPC } from '@shared/update-lifecycle'
import { registerUpdateIpc, type UpdateIpcDeps } from './update-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

function setup(over: Partial<UpdateIpcDeps> = {}) {
  const handlers = new Map<string, Handler>()
  const send = vi.fn()
  let push: (s: UpdateLifecycleState) => void = () => {}
  const dispose = vi.fn()
  const deps: UpdateIpcDeps = {
    ipcMain: { handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as UpdateIpcDeps['ipcMain'],
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    getWindow: () => ({ isDestroyed: () => false, webContents: { send } }) as never,
    checkForUpdateNow: vi.fn(async () => ({
      ok: true as const,
      current: '2.0.0',
      latest: '2.1.0',
      available: true,
      url: 'https://x'
    })),
    startUpdateDownload: vi.fn(async () => ({ started: true })),
    requestInstall: vi.fn(async () => ({ installed: false as const, deferred: ['meeting' as const] })),
    getUpdateState: () => ({ phase: 'ready', version: '2.1.0' }),
    onUpdateState: (listener) => {
      push = listener
      return dispose
    },
    ...over
  }
  const unsubscribe = registerUpdateIpc(deps)
  return { handlers, send, deps, push: (s: UpdateLifecycleState) => push(s), unsubscribe, dispose }
}

describe('G86 registerUpdateIpc', () => {
  it('refuses a sender that is not the main window, on every channel', async () => {
    const { handlers } = setup({
      assertMainWindow: () => {
        throw new Error('Untrusted sender')
      }
    })
    for (const channel of [IPC.updateCheck, IPC.updateDownload, IPC.updateInstall, UPDATE_LIFECYCLE_IPC.stateGet]) {
      expect(() => handlers.get(channel)?.({})).toThrow('Untrusted sender')
    }
  })

  it('keeps the signed-out shapes', async () => {
    const { handlers, deps } = setup({ requireAuth: () => false })
    expect(await handlers.get(IPC.updateCheck)?.({})).toEqual({ ok: false, current: '', error: 'Not signed in.' })
    expect(await handlers.get(IPC.updateDownload)?.({})).toEqual({ started: false, reason: 'Not signed in.' })
    expect(await handlers.get(IPC.updateInstall)?.({})).toEqual({ installed: false, reason: 'not-signed-in' })
    expect(deps.requestInstall).not.toHaveBeenCalled()
    expect(deps.startUpdateDownload).not.toHaveBeenCalled()
  })

  it('install answers inline with why it was deferred', async () => {
    const { handlers } = setup()
    expect(await handlers.get(IPC.updateInstall)?.({})).toEqual({ installed: false, deferred: ['meeting'] })
  })

  it('stateGet returns a validated snapshot and degrades a malformed one to idle', () => {
    expect(setup().handlers.get(UPDATE_LIFECYCLE_IPC.stateGet)?.({})).toEqual({ phase: 'ready', version: '2.1.0' })
    const bad = setup({ getUpdateState: () => ({ phase: 'ready', secret: 'x' }) as never })
    expect(bad.handlers.get(UPDATE_LIFECYCLE_IPC.stateGet)?.({})).toEqual({ phase: 'idle' })
  })

  it('pushes every transition to the main window, validated', () => {
    const { push, send } = setup()
    push({ phase: 'install-deferred', version: '2.1.0', deferred: ['task'] })
    expect(send).toHaveBeenCalledWith(UPDATE_LIFECYCLE_IPC.state, {
      phase: 'install-deferred',
      version: '2.1.0',
      deferred: ['task']
    })
    send.mockClear()
    push({ phase: 'ready', leaked: 'meeting title' } as never)
    expect(send).not.toHaveBeenCalled()
  })

  it('returns the disposer that stops the push', () => {
    const { unsubscribe, dispose } = setup()
    unsubscribe()
    expect(dispose).toHaveBeenCalled()
  })
})
