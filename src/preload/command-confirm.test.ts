import { describe, expect, it, vi } from 'vitest'
import { COMMAND_CONFIRM_IPC } from '../shared/metis-command-contract'
import { createCommandConfirmPreloadApi } from './command-confirm'

function fakeIpc(invokeResult: unknown = undefined) {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  return {
    listeners,
    ipc: {
      on: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        set.add(fn)
        listeners.set(channel, set)
      }),
      removeListener: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(fn)
      }),
      invoke: vi.fn(async () => invokeResult)
    },
    push: (channel: string, payload: unknown) => {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, payload)
    }
  }
}

describe('command confirmation preload bridge', () => {
  it('delivers a well-formed notice and drops anything else', () => {
    const { ipc, push } = fakeIpc()
    const api = createCommandConfirmPreloadApi(ipc as never)
    const seen: unknown[] = []
    api.onMetisCommandNotice((notice) => seen.push(notice))
    push(COMMAND_CONFIRM_IPC.notice, {
      code: 'automation_denied',
      copy: "Métis isn't allowed to control Notes.",
      settingsKind: 'automation'
    })
    push(COMMAND_CONFIRM_IPC.notice, { code: 'signed_out', copy: 'Sign in to Métis to use voice actions.' })
    push(COMMAND_CONFIRM_IPC.notice, { code: 'signed_out', copy: 'x', extra: 1 })
    push(COMMAND_CONFIRM_IPC.notice, { code: 'not_a_code', copy: 'x' })
    push(COMMAND_CONFIRM_IPC.notice, { code: 'app_missing', copy: 'x', settingsKind: 'rm -rf' })
    push(COMMAND_CONFIRM_IPC.notice, 'nope')
    expect(seen).toEqual([
      { code: 'automation_denied', copy: "Métis isn't allowed to control Notes.", settingsKind: 'automation' },
      { code: 'signed_out', copy: 'Sign in to Métis to use voice actions.' }
    ])
  })

  it('unsubscribes', () => {
    const { ipc, listeners } = fakeIpc()
    const off = createCommandConfirmPreloadApi(ipc as never).onMetisCommandNotice(() => {})
    expect(listeners.get(COMMAND_CONFIRM_IPC.notice)?.size).toBe(1)
    off()
    expect(listeners.get(COMMAND_CONFIRM_IPC.notice)?.size).toBe(0)
  })

  it('takes recovery notices once from main and keeps only the validated shape', async () => {
    const { ipc } = fakeIpc([
      { taskId: 'desktop-action:a', actionId: 'desktop.create_note', copy: 'A voice action may not have finished.' },
      { taskId: 1, copy: 'bad' }
    ])
    const api = createCommandConfirmPreloadApi(ipc as never)
    expect(await api.takeMetisCommandRecoveryNotices()).toEqual([
      { taskId: 'desktop-action:a', actionId: 'desktop.create_note', copy: 'A voice action may not have finished.' }
    ])
    expect(ipc.invoke).toHaveBeenCalledWith(COMMAND_CONFIRM_IPC.recoveryNotices)
  })

  it('returns an empty list when main answers with something else', async () => {
    const { ipc } = fakeIpc('nope')
    expect(await createCommandConfirmPreloadApi(ipc as never).takeMetisCommandRecoveryNotices()).toEqual([])
  })
})
