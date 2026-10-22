import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type Settings } from '@shared/ipc'

const settings = { meetingsFolder: '/meetings' } as unknown as Settings

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  deleteMeeting: vi.fn(async () => ({ ok: true })),
  deleteAllMeetings: vi.fn(async () => ({ ok: true, deleted: 2, failed: [] as string[] })),
  readSavedMeeting: vi.fn(async () => '# meeting'),
  requestSourceRefresh: vi.fn(async () => {}),
  publishMeetingCard: vi.fn(async () => {}),
  exciseDeletedMeeting: vi.fn(async () => ({ gone: true })),
  listMeetings: vi.fn(async () => [{}, {}]),
  purgeBrain: vi.fn(() => ({ ok: true })),
  removeWiki: vi.fn(() => ({ ok: true })),
  purgeGraphArtifacts: vi.fn(() => true),
  scheduleRebuild: vi.fn(async () => {})
}))

vi.mock('../store', () => ({ getSettings: () => settings }))
vi.mock('../logger', () => ({ auditLog: mocks.auditLog, mainLog: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../brain/ingest', () => ({
  enqueueIngest: vi.fn(),
  exciseDeletedMeeting: mocks.exciseDeletedMeeting,
  requestSourceRefresh: mocks.requestSourceRefresh
}))
vi.mock('../brain/publish', () => ({
  publishAll: vi.fn(),
  publishMeetingCard: mocks.publishMeetingCard,
  removeWiki: mocks.removeWiki
}))
vi.mock('../brain/store', () => ({ purgeBrain: mocks.purgeBrain }))
vi.mock('../meeting-path', () => ({
  safeMeetingBasename: (file: unknown) => (typeof file === 'string' && file.endsWith('.md') ? file : null)
}))
vi.mock('../transcripts', () => ({ resolveMeetingsFolder: () => '/meetings', appendDebrief: vi.fn() }))
vi.mock('../history-actions', () => ({ readSavedMeeting: mocks.readSavedMeeting }))
vi.mock('../history-read', () => ({ listMeetings: mocks.listMeetings }))
vi.mock('../recall', () => ({
  recallRead: vi.fn(),
  openExplicitly: vi.fn(),
  deleteMeeting: mocks.deleteMeeting,
  renameMeeting: vi.fn(),
  updateMeetingRecap: vi.fn(),
  setMeetingConfidential: vi.fn(),
  setMeetingCrmPushed: vi.fn(),
  deleteAllMeetings: mocks.deleteAllMeetings
}))
vi.mock('../graphify', () => ({
  purgeGraphArtifacts: mocks.purgeGraphArtifacts,
  scheduleRebuild: mocks.scheduleRebuild
}))

import { registerRecallIpc } from './recall-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

const CHANNELS = [
  IPC.recallRead,
  IPC.recallExportPlain,
  IPC.recallDelete,
  IPC.recallRename,
  IPC.recallUpdateRecap,
  IPC.recallSetConfidential,
  IPC.recallSetCrmPushed,
  IPC.recallBackfillSpeakers,
  IPC.debriefSave,
  IPC.recallDeleteAll
]

function setup(overrides: { requireAuth?: () => boolean; response?: number } = {}) {
  const handlers = new Map<string, Handler>()
  const assertMainWindow = vi.fn()
  const writeTextFile = vi.fn()
  registerRecallIpc({
    ipcMain: {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as Handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow,
    requireAuth: overrides.requireAuth ?? (() => true),
    showMessageBox: vi.fn(async () => ({ response: overrides.response ?? 0 })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/out/meeting.md' })),
    downloadsPath: () => '/downloads',
    writeTextFile,
    backfillSpeakerNames: vi.fn(async () => ({ ok: true, named: 1 }))
  })
  const handler = (channel: string): Handler => {
    const found = handlers.get(channel)
    if (!found) throw new Error(`${channel} was not registered`)
    return found
  }
  return { handlers, handler, assertMainWindow, writeTextFile }
}

const event = { sender: { send: vi.fn() } } as unknown as IpcMainInvokeEvent

beforeEach(() => {
  vi.clearAllMocks()
})

describe('recall IPC', () => {
  it('registers every recall channel and checks the main-window sender first on each', async () => {
    const { handlers, handler, assertMainWindow } = setup({ requireAuth: () => false })
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort())
    for (const channel of CHANNELS) {
      assertMainWindow.mockClear()
      await handler(channel)(event, {}, {})
      expect(assertMainWindow, channel).toHaveBeenCalledWith(event)
    }
  })

  it('refuses a rejected sender before the sign-in check or any deletion', async () => {
    const requireAuth = vi.fn(() => true)
    const { handler, assertMainWindow } = setup({ requireAuth })
    assertMainWindow.mockImplementation(() => {
      throw new Error('IPC denied: not main frame')
    })
    await expect(handler(IPC.recallDeleteAll)(event)).rejects.toThrow('IPC denied')
    await expect(handler(IPC.recallDelete)(event, 'a.md', 'A')).rejects.toThrow('IPC denied')
    expect(requireAuth).not.toHaveBeenCalled()
    expect(mocks.deleteAllMeetings).not.toHaveBeenCalled()
    expect(mocks.deleteMeeting).not.toHaveBeenCalled()
  })

  it('answers every channel with the sign-in error when signed out', async () => {
    const { handler } = setup({ requireAuth: () => false })
    for (const channel of CHANNELS) {
      expect(await handler(channel)(event, {}, {}), channel).toEqual({
        ok: false,
        error: 'Sign in with your Mantu account first.'
      })
    }
  })

  it('does not delete a meeting the user declined, and rejects a non-meeting file name', async () => {
    const declined = setup({ response: 1 })
    expect(await declined.handler(IPC.recallDelete)(event, 'a.md', 'A')).toEqual({ ok: false, error: 'cancelled' })
    expect(mocks.deleteMeeting).not.toHaveBeenCalled()
    expect(await declined.handler(IPC.recallDelete)(event, '../etc/passwd', 'A')).toEqual({
      ok: false,
      error: 'Not a saved meeting file.'
    })
  })

  it('deletes a confirmed meeting, audits it and removes its derived residue', async () => {
    const { handler } = setup()
    expect(await handler(IPC.recallDelete)(event, 'a.md', 'A')).toEqual({ ok: true })
    expect(mocks.deleteMeeting).toHaveBeenCalledWith('a.md')
    expect(mocks.auditLog).toHaveBeenCalledWith('transcript.deleted', { file: 'a.md' })
    expect(mocks.exciseDeletedMeeting).toHaveBeenCalledWith(settings, 'a.md')
    expect(mocks.requestSourceRefresh).toHaveBeenCalledWith(settings)
  })

  it('recallDelete purges graph artifacts and schedules a rebuild', async () => {
    const { handler } = setup()
    expect(await handler(IPC.recallDelete)(event, 'a.md', 'A')).toEqual({ ok: true })
    expect(mocks.purgeGraphArtifacts).toHaveBeenCalledTimes(1)
    expect(mocks.scheduleRebuild).toHaveBeenCalledTimes(1)
  })

  it('recallDelete leaves the graph alone when the delete failed or was declined', async () => {
    mocks.deleteMeeting.mockResolvedValueOnce({ ok: false, error: 'Could not delete meeting file.' } as never)
    const failed = setup()
    await failed.handler(IPC.recallDelete)(event, 'a.md', 'A')
    const declined = setup({ response: 1 })
    await declined.handler(IPC.recallDelete)(event, 'a.md', 'A')
    expect(mocks.purgeGraphArtifacts).not.toHaveBeenCalled()
    expect(mocks.scheduleRebuild).not.toHaveBeenCalled()
  })

  it('exports the decrypted copy through the injected writer only after the save dialog', async () => {
    const { handler, writeTextFile } = setup()
    expect(await handler(IPC.recallExportPlain)(event, 'a.md')).toEqual({ ok: true, path: '/out/meeting.md' })
    expect(writeTextFile).toHaveBeenCalledWith('/out/meeting.md', '# meeting')
    expect(mocks.auditLog).toHaveBeenCalledWith('recall.export', { file: 'a.md' })
  })

  it('erases everything through the bulk flow and audits the counts', async () => {
    const { handler } = setup()
    expect(await handler(IPC.recallDeleteAll)(event)).toEqual({ ok: true, deleted: 2, failed: [] })
    expect(mocks.auditLog).toHaveBeenCalledWith('transcript.deleted', {
      bulk: true,
      deleted: 2,
      failed: 0,
      brainPurged: true,
      wikiRemoved: true
    })
  })
})
