import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/ipc'
import { RecoveredDraftCount } from '../recovered-draft-count'
import { registerRecoveredDraftCountIpc } from './recovered-draft-count-ipc'

function register(requireAuth: () => boolean, assertMainWindow: (event: IpcMainInvokeEvent) => void = vi.fn()) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>()
  const counter = new RecoveredDraftCount()
  registerRecoveredDraftCountIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (event: IpcMainInvokeEvent) => unknown)
      }
    } as Pick<IpcMain, 'handle'>,
    assertMainWindow,
    requireAuth,
    counter
  })
  const handler = handlers.get(IPC.recoveredDraftCount)
  if (!handler) throw new Error('recoveredDraftCount handler was not registered')
  return { handler, counter, assertMainWindow }
}

describe('recovered draft count IPC', () => {
  it('returns the authenticated snapshot after checking the sender', () => {
    const { handler, counter, assertMainWindow } = register(() => true)
    counter.recordRecovered(counter.revisionToken(), 2)
    const event = {} as IpcMainInvokeEvent
    expect(handler(event)).toEqual({ count: 2, revision: 1 })
    expect(assertMainWindow).toHaveBeenCalledWith(event)
  })

  it('reports zero drafts without auth but keeps the revision current', () => {
    const { handler, counter } = register(() => false)
    counter.recordRecovered(counter.revisionToken(), 2)
    expect(handler({} as IpcMainInvokeEvent)).toEqual({ count: 0, revision: 1 })
  })

  it('refuses a non-main sender before reading the count', () => {
    const requireAuth = vi.fn(() => true)
    const { handler } = register(requireAuth, () => {
      throw new Error('not the main window')
    })
    expect(() => handler({} as IpcMainInvokeEvent)).toThrow('not the main window')
    expect(requireAuth).not.toHaveBeenCalled()
  })

  it('reflects a profile recovery as a newer empty revision', () => {
    const { handler, counter } = register(() => true)
    counter.recordRecovered(counter.revisionToken(), 3)
    counter.resetForProfileRecovery()
    expect(handler({} as IpcMainInvokeEvent)).toEqual({ count: 0, revision: 2 })
  })
})
