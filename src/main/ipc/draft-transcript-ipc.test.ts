import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { Settings } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import type { SaveDraftTranscriptResult } from '@shared/ipc'
import { bindTranscriptCheckpointStore } from '../features/meetings/transcript-checkpoint-binding'
import type { CheckpointResult } from '../features/meetings/transcript-revision-store'
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

describe('draft transcript IPC checkpoint (WP03-S03)', () => {
  const STARTED = 1_700_000_000_000
  const register = (status: SaveDraftTranscriptResult['status']) => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>()
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
      saveDraftTranscript: vi.fn(async () => ({ status }))
    })
    return (payload: unknown) => handlers.get(IPC.saveDraftTranscript)?.({} as IpcMainInvokeEvent, payload)
  }
  const payload = { title: 'Standup', startedAt: STARTED, lines: [], recap: '', mode: 'meeting' }

  it('checkpoints the meeting once after a saved draft and returns the save receipt unchanged', async () => {
    const checkpoint = vi.fn(async (): Promise<CheckpointResult> => ({ ok: true, revision: 3 }))
    const unbind = bindTranscriptCheckpointStore({ checkpoint, snapshot: () => null })
    try {
      await expect(register('saved')(payload)).resolves.toEqual({ status: 'saved' })
      expect(checkpoint).toHaveBeenCalledTimes(1)
      expect(checkpoint).toHaveBeenCalledWith(STARTED)
    } finally {
      unbind()
    }
  })

  it('does not checkpoint a disabled or failed draft save', async () => {
    const checkpoint = vi.fn(async (): Promise<CheckpointResult> => ({ ok: true, revision: 3 }))
    const unbind = bindTranscriptCheckpointStore({ checkpoint, snapshot: () => null })
    try {
      await expect(register('disabled')(payload)).resolves.toEqual({ status: 'disabled' })
      await expect(register('failed')(payload)).resolves.toEqual({ status: 'failed' })
      expect(checkpoint).not.toHaveBeenCalled()
    } finally {
      unbind()
    }
  })

  it('a throwing checkpoint never changes the save receipt', async () => {
    const unbind = bindTranscriptCheckpointStore({
      checkpoint: async () => {
        throw new Error('disk gone')
      },
      snapshot: () => null
    })
    try {
      await expect(register('saved')(payload)).resolves.toEqual({ status: 'saved' })
    } finally {
      unbind()
    }
  })
})
