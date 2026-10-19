import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Settings } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import { registerDraftTranscriptIpc } from './draft-transcript-ipc'

describe('draft transcript IPC live meeting identity', () => {
  it('rejects zero and other invalid live identities before admitting a draft write', async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
    const saveDraftTranscript = vi.fn(async () => ({ status: 'saved' as const }))
    registerDraftTranscriptIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler as (...args: any[]) => Promise<unknown>)
        }
      } as Pick<IpcMain, 'handle'>,
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      captureAuthSessionBoundary: () => () => true,
      getSettings: () => ({}) as Settings,
      captureDraftSettingsBoundary: () => () => true,
      saveDraftTranscript
    })

    const handler = handlers.get(IPC.saveDraftTranscript)
    expect(handler).toBeDefined()
    for (const startedAt of [0, -1, 1.5, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      await expect(
        handler?.({} as IpcMainInvokeEvent, {
          startedAt,
          lines: [],
          recap: '',
          mode: 'meeting'
        })
      ).resolves.toEqual({ status: 'failed' })
    }
    expect(saveDraftTranscript).not.toHaveBeenCalled()
  })
})
