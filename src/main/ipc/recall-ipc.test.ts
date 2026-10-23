import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type Settings } from '@shared/ipc'

const settings = { meetingsFolder: '/meetings' } as unknown as Settings

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  deleteMeeting: vi.fn(async () => ({ ok: true })),
  deleteAllMeetings: vi.fn(async () => ({ ok: true, deleted: 2, failed: [] as string[] })),
  readSavedMeeting: vi.fn(async () => '# meeting'),
  requestSourceRefresh: vi.fn(async () => {}),
  enqueueIngest: vi.fn(async () => {}),
  acknowledgeMetadataEdit: vi.fn(async () => {}),
  appendDebrief: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  renameMeeting: vi.fn(async () => ({ ok: true })),
  updateMeetingRecap: vi.fn(async () => ({ ok: true })),
  setMeetingConfidential: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
  setMeetingCrmPushed: vi.fn(async () => ({ ok: true })),
  publishAll: vi.fn(async () => {}),
  publishMeetingCard: vi.fn(async () => {}),
  exciseDeletedMeeting: vi.fn(async () => ({ gone: true })),
  listMeetings: vi.fn(async (): Promise<{ file?: string }[]> => [{}, {}]),
  isOwnedMeetingFile: vi.fn(async (_folder: string, _file: string): Promise<boolean | symbol> => true),
  purgeBrain: vi.fn(() => ({ ok: true })),
  removeWiki: vi.fn(() => ({ ok: true })),
  purgeGraphArtifacts: vi.fn(() => true),
  scheduleRebuild: vi.fn(async () => {}),
  setMeetingPushMarker: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
}))

vi.mock('../store', () => ({ getSettings: () => settings }))
vi.mock('../logger', () => ({ auditLog: mocks.auditLog, mainLog: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../brain/ingest', () => ({
  enqueueIngest: mocks.enqueueIngest,
  acknowledgeMetadataEdit: mocks.acknowledgeMetadataEdit,
  exciseDeletedMeeting: mocks.exciseDeletedMeeting,
  requestSourceRefresh: mocks.requestSourceRefresh
}))
vi.mock('../brain/publish', () => ({
  publishAll: mocks.publishAll,
  publishMeetingCard: mocks.publishMeetingCard,
  removeWiki: mocks.removeWiki
}))
vi.mock('../brain/store', () => ({ purgeBrain: mocks.purgeBrain }))
vi.mock('../meeting-path', () => ({
  safeMeetingBasename: (file: unknown) => (typeof file === 'string' && file.endsWith('.md') ? file : null)
}))
vi.mock('../transcripts', () => ({ resolveMeetingsFolder: () => '/meetings', appendDebrief: mocks.appendDebrief }))
vi.mock('../history-actions', () => ({ readSavedMeeting: mocks.readSavedMeeting }))
vi.mock('../history-read', () => ({ listMeetings: mocks.listMeetings }))
vi.mock('../recall', () => ({
  recallRead: vi.fn(),
  openExplicitly: vi.fn(),
  deleteMeeting: mocks.deleteMeeting,
  renameMeeting: mocks.renameMeeting,
  updateMeetingRecap: mocks.updateMeetingRecap,
  setMeetingConfidential: mocks.setMeetingConfidential,
  setMeetingCrmPushed: mocks.setMeetingCrmPushed,
  setMeetingPushMarker: mocks.setMeetingPushMarker,
  deleteAllMeetings: mocks.deleteAllMeetings
}))
vi.mock('../graphify', () => ({
  purgeGraphArtifacts: mocks.purgeGraphArtifacts,
  scheduleRebuild: mocks.scheduleRebuild
}))
vi.mock('../meeting-privacy', () => ({ isOwnedMeetingFile: mocks.isOwnedMeetingFile }))

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
  IPC.recallSetPushMarker,
  IPC.recallBackfillSpeakers,
  IPC.debriefSave,
  IPC.recallDeleteAll
]

function setup(overrides: { requireAuth?: () => boolean; response?: number } = {}) {
  const handlers = new Map<string, Handler>()
  const assertMainWindow = vi.fn()
  const receipt = {
    exportId: 'e1',
    kind: 'meeting-markdown',
    destination: '/out/meeting.md',
    bytes: 9,
    sha256: 'a'.repeat(64),
    writtenAt: '2026-10-23T12:00:00.000Z',
    conflictResolution: 'none'
  }
  const exportFile = vi.fn(async (_request: unknown) => ({ ok: true as const, receipt, receiptLogged: true }))
  const showMessageBox = vi.fn(async (_options: { message?: string }) => ({ response: overrides.response ?? 0 }))
  registerRecallIpc({
    ipcMain: {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as Handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow,
    requireAuth: overrides.requireAuth ?? (() => true),
    showMessageBox,
    exporter: { exportFile, exportDirectory: vi.fn() } as never,
    downloadsPath: () => '/downloads',
    backfillSpeakerNames: vi.fn(async () => ({ ok: true, named: 1 }))
  })
  const handler = (channel: string): Handler => {
    const found = handlers.get(channel)
    if (!found) throw new Error(`${channel} was not registered`)
    return found
  }
  return { handlers, handler, assertMainWindow, exportFile, receipt, showMessageBox }
}

const event = { sender: { send: vi.fn() } } as unknown as IpcMainInvokeEvent

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isOwnedMeetingFile.mockImplementation(async () => true)
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

  it('exports the decrypted copy through the shared export service', async () => {
    const { handler, exportFile, receipt } = setup()
    expect(await handler(IPC.recallExportPlain)(event, 'a.md')).toEqual({ ok: true, path: '/out/meeting.md', receipt })
    const request = exportFile.mock.calls[0][0] as { kind: string; bytes: Buffer }
    expect(request.kind).toBe('meeting-markdown')
    expect(request.bytes.toString('utf8')).toBe('# meeting')
    expect(mocks.auditLog).toHaveBeenCalledWith('recall.export', { file: 'a.md' })
  })

  it('counts only Métis meetings in the delete-all confirmation, never files it will leave in place (Q10, D4-19)', async () => {
    mocks.listMeetings.mockResolvedValueOnce([{ file: 'a.md' }, { file: 'b.md' }, { file: 'notes.md' }])
    mocks.isOwnedMeetingFile.mockImplementation(async (_folder, file) => file !== 'notes.md')
    const { handler, showMessageBox } = setup()
    await handler(IPC.recallDeleteAll)(event)
    expect(mocks.isOwnedMeetingFile).toHaveBeenCalledWith('/meetings', 'notes.md')
    expect(showMessageBox.mock.calls[0][0].message).toBe('Delete all 2 saved meetings?')
  })

  it('counts a file it cannot read yet, because the wipe will try it and report it if it fails (Q10, D4-19)', async () => {
    mocks.listMeetings.mockResolvedValueOnce([{ file: 'a.md' }, { file: 'locked.md' }])
    mocks.isOwnedMeetingFile.mockImplementation(async (_folder, file) =>
      file === 'locked.md' ? Symbol('unreadable') : true
    )
    const { handler, showMessageBox } = setup()
    await handler(IPC.recallDeleteAll)(event)
    expect(showMessageBox.mock.calls[0][0].message).toBe('Delete all 2 saved meetings?')
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

  describe('metadata-only edits never rebuild the whole brain (Q04b)', () => {
    const MEETING = join('/meetings', 'a.md')

    it('rename, recap and debrief re-ingest that meeting only, never a forced whole-brain refresh', async () => {
      const { handler } = setup()
      await handler(IPC.recallRename)(event, { file: 'a.md', title: 'New title' })
      await handler(IPC.recallUpdateRecap)(event, { file: 'a.md', recap: 'Fixed a name.' })
      await handler(IPC.debriefSave)(event, { file: 'a.md', text: 'Gut read.' })
      expect(mocks.enqueueIngest).toHaveBeenCalledTimes(3)
      for (const call of mocks.enqueueIngest.mock.calls) {
        expect(call).toEqual([MEETING, { force: true, reingest: true }])
      }
      expect(mocks.requestSourceRefresh).not.toHaveBeenCalled()
    })

    it('a failed rename or recap write schedules no ingest', async () => {
      mocks.renameMeeting.mockResolvedValueOnce({ ok: false } as never)
      mocks.updateMeetingRecap.mockResolvedValueOnce({ ok: false } as never)
      const { handler } = setup()
      await handler(IPC.recallRename)(event, { file: 'a.md', title: 'New title' })
      await handler(IPC.recallUpdateRecap)(event, { file: 'a.md', recap: 'x' })
      expect(mocks.enqueueIngest).not.toHaveBeenCalled()
    })

    it('confidential and CRM-pushed writes acknowledge the new source version and schedule no ingest', async () => {
      const { handler } = setup()
      await handler(IPC.recallSetConfidential)(event, { file: 'a.md', confidential: true })
      await handler(IPC.recallSetCrmPushed)(event, { file: 'a.md', key: 'abc123' })
      expect(mocks.acknowledgeMetadataEdit).toHaveBeenCalledTimes(2)
      expect(mocks.acknowledgeMetadataEdit).toHaveBeenNthCalledWith(1, settings, MEETING)
      expect(mocks.acknowledgeMetadataEdit).toHaveBeenNthCalledWith(2, settings, MEETING)
      expect(mocks.enqueueIngest).not.toHaveBeenCalled()
      expect(mocks.requestSourceRefresh).not.toHaveBeenCalled()
    })

    it('does not acknowledge a write that failed, and an acknowledge failure never fails the edit', async () => {
      mocks.setMeetingCrmPushed.mockResolvedValueOnce({ ok: false } as never)
      const { handler } = setup()
      await handler(IPC.recallSetCrmPushed)(event, { file: 'a.md', key: 'abc123' })
      expect(mocks.acknowledgeMetadataEdit).not.toHaveBeenCalled()
      mocks.acknowledgeMetadataEdit.mockRejectedValueOnce(new Error('index locked'))
      expect(await handler(IPC.recallSetCrmPushed)(event, { file: 'a.md', key: 'abc123' })).toEqual({ ok: true })
    })
  })
})

describe('recall IPC — honest flags and bounded debriefs (Q07)', () => {
  it('recallSetConfidential reports flagSaved with the reason when the republish fails (D4-1)', async () => {
    mocks.publishAll.mockRejectedValueOnce(new Error('EPERM'))
    const { handler } = setup()
    const result = (await handler(IPC.recallSetConfidential)(event, { file: 'a.md', confidential: true })) as {
      ok: boolean
      flagSaved?: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.flagSaved).toBe(true)
    expect(result.error).toMatch(/Flag saved/)
  })

  it('recallSetConfidential does not claim a saved flag when the frontmatter write itself failed', async () => {
    mocks.setMeetingConfidential.mockResolvedValueOnce({ ok: false, error: 'Could not save the confidential flag.' })
    const { handler } = setup()
    const result = (await handler(IPC.recallSetConfidential)(event, { file: 'a.md', confidential: true })) as {
      flagSaved?: boolean
    }
    expect(result.flagSaved).toBeUndefined()
    expect(mocks.publishAll).not.toHaveBeenCalled()
  })

  it('debriefSave refuses text over 8000 chars instead of cutting it (D4-5)', async () => {
    const { handler } = setup()
    expect(await handler(IPC.debriefSave)(event, { file: 'a.md', text: 'x'.repeat(8001) })).toEqual({
      ok: false,
      error: 'Debrief is too long (8,000 characters max).'
    })
    expect(mocks.appendDebrief).not.toHaveBeenCalled()
    await handler(IPC.debriefSave)(event, { file: 'a.md', text: 'x'.repeat(8000) })
    expect(mocks.appendDebrief).toHaveBeenCalledTimes(1)
  })

  it('recallSetPushMarker validates the payload and forwards a known field (D4-6)', async () => {
    const { handler } = setup()
    const marker = handler(IPC.recallSetPushMarker)
    expect((await marker(event, { file: 'a.md', field: 'confidential', key: 'k1' })) as { ok: boolean }).toMatchObject({
      ok: false
    })
    expect(
      (await marker(event, { file: 'a.md', field: 'clickup_pushed', key: 'bad key' })) as { ok: boolean }
    ).toMatchObject({
      ok: false
    })
    expect(mocks.setMeetingPushMarker).not.toHaveBeenCalled()
    expect(await marker(event, { file: 'a.md', field: 'clickup_pushed', key: 'k1' })).toEqual({ ok: true })
    expect(mocks.setMeetingPushMarker).toHaveBeenCalledWith(settings, 'a.md', 'clickup_pushed', 'k1')
    // Metadata-only write (Q04b): acknowledged, never an ingest or a whole-brain refresh.
    expect(mocks.acknowledgeMetadataEdit).toHaveBeenCalledWith(settings, join('/meetings', 'a.md'))
    expect(mocks.enqueueIngest).not.toHaveBeenCalled()
    expect(mocks.requestSourceRefresh).not.toHaveBeenCalled()
  })
})
