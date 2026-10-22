import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type Settings } from '@shared/ipc'

const settings = { asrCorrections: [] } as unknown as Settings

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  markBrainChanged: vi.fn(async () => {}),
  setDealOutcome: vi.fn(async () => true),
  readAliasMap: vi.fn(() => ({})),
  resolveEntitySlug: vi.fn((_aliases: unknown, _kind: string, slug: string) => `resolved-${slug}`),
  startRebuild: vi.fn(async () => ({ queued: 3 }) as { queued: number; error?: string }),
  startIntelligencePass: vi.fn(() => ({ started: true })),
  runIntelligenceIndex: vi.fn(async () => ({ ran: true, queued: 1, recapped: 0 })),
  readBrainDashboard: vi.fn(async () => ({ dashboard: true })),
  loadBrainEntityDisplayNames: vi.fn(async () => ({ names: ['Ada'] })),
  openIntelligenceWindow: vi.fn(() => ({ ok: true })),
  requestBackfill: vi.fn(async () => ({ queued: 0, deferred: 0 })),
  computeAttention: vi.fn(() => []),
  listPreservedBrainIndexes: vi.fn(() => []),
  currentBrainIndexIsReadable: vi.fn(() => false),
  deletePreservedBrainIndex: vi.fn(() => ({ ok: true })),
  clearJournalCorruptionLock: vi.fn(() => true)
}))

vi.mock('../store', () => ({ getSettings: () => settings, setSettings: vi.fn() }))
vi.mock('../logger', () => ({
  auditLog: mocks.auditLog,
  mainLog: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}))
vi.mock('../brain/ingest', () => ({
  markBrainChanged: mocks.markBrainChanged,
  requestBackfill: mocks.requestBackfill,
  brainBackfillProgress: vi.fn(),
  brainLiveIngestProgress: vi.fn(),
  ingestFailureCounts: vi.fn(),
  ingestFailureDetails: vi.fn(),
  isPendingIngestRecord: vi.fn(),
  settleCommitment: vi.fn(),
  startRebuild: mocks.startRebuild
}))
vi.mock('../brain/intelligence-pass', () => ({ startIntelligencePass: mocks.startIntelligencePass }))
vi.mock('../brain/corrections', () => ({
  renameEntity: vi.fn(),
  mergeEntities: vi.fn(),
  unmergeEntities: vi.fn(),
  updateEntityField: vi.fn(),
  readFieldProvenance: vi.fn(),
  rejectCommitment: vi.fn(),
  isJournalCorruptionBlockedAsync: vi.fn(),
  clearJournalCorruptionLock: mocks.clearJournalCorruptionLock,
  readCorrectionsJournal: vi.fn(() => []),
  readAliasMap: mocks.readAliasMap,
  resolveEntitySlug: mocks.resolveEntitySlug
}))
vi.mock('../brain/publish', () => ({ publishEntity: vi.fn(), removeFromWiki: vi.fn() }))
vi.mock('../brain/attention', () => ({ computeAttention: mocks.computeAttention }))
vi.mock('../intelligence', () => ({ openIntelligenceWindow: mocks.openIntelligenceWindow }))
vi.mock('../brain/store', () => ({
  loadIndexForStatus: vi.fn(),
  indexUnavailableAsync: vi.fn(),
  indexUnavailableMessage: vi.fn(),
  readPerson: vi.fn(),
  readAccount: vi.fn(),
  readDeal: vi.fn(),
  loadEntityDisplayNames: mocks.loadBrainEntityDisplayNames,
  loadMeetingExtraction: vi.fn(),
  listPreservedBrainIndexes: mocks.listPreservedBrainIndexes,
  currentBrainIndexIsReadable: mocks.currentBrainIndexIsReadable,
  restorePreservedBrainIndex: vi.fn(),
  deletePreservedBrainIndex: mocks.deletePreservedBrainIndex,
  setDealOutcome: mocks.setDealOutcome,
  slugify: (value: string) => value
}))
vi.mock('../brain/dashboard-read', () => ({
  brainStatusCounts: vi.fn(),
  readBrainDashboard: mocks.readBrainDashboard
}))
vi.mock('../brain/intelligence-index', () => ({
  runIntelligenceIndex: mocks.runIntelligenceIndex,
  lastIndexedAtAsync: vi.fn(),
  intelligenceIndexStatusAsync: vi.fn(),
  SIGN_IN_INDEX_COPY: 'Sign in to index.'
}))

import { registerBrainIpc } from './brain-ipc'

type Handler = (event: IpcMainInvokeEvent, raw?: unknown) => Promise<unknown> | unknown

const READER_CHANNELS = [
  IPC.brainStatus,
  IPC.brainBackfill,
  IPC.brainIntelligencePass,
  IPC.brainRead,
  IPC.brainFieldDecision
]
const MAIN_WINDOW_CHANNELS = [
  IPC.brainOpenDashboard,
  IPC.brainRebuildAll,
  IPC.brainPreservedIndexesList,
  IPC.brainPreservedIndexRestore,
  IPC.brainPreservedIndexDelete,
  IPC.brainClearJournalCorruption,
  IPC.brainEntityNames,
  IPC.brainSetDealOutcome,
  IPC.brainEntityRename,
  IPC.brainEntityMerge,
  IPC.brainEntityUnmerge,
  IPC.brainEntityUpdateField,
  IPC.brainCommitmentReject,
  IPC.brainMeetingExtraction,
  IPC.brainAttention,
  IPC.brainCommitmentSettle
]

function setup(
  overrides: { requireAuth?: () => boolean; showMessageBox?: (options: unknown) => Promise<{ response: number }> } = {}
) {
  const handlers = new Map<string, Handler>()
  const assertMainWindow = vi.fn()
  const assertBrainReader = vi.fn()
  registerBrainIpc({
    ipcMain: {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as Handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow,
    assertBrainReader,
    requireAuth: overrides.requireAuth ?? (() => true),
    getWindow: () => null,
    showMessageBox: overrides.showMessageBox ?? vi.fn(async () => ({ response: 0 })),
    barCollapsedMaxHeight: 160
  })
  const handler = (channel: string): Handler => {
    const found = handlers.get(channel)
    if (!found) throw new Error(`${channel} was not registered`)
    return found
  }
  return { handlers, handler, assertMainWindow, assertBrainReader }
}

const event = {} as IpcMainInvokeEvent

beforeEach(() => {
  vi.clearAllMocks()
})

describe('brain IPC registration', () => {
  it('registers every brain channel exactly once', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual([...READER_CHANNELS, ...MAIN_WINDOW_CHANNELS].sort())
  })

  it('gates the reader channels with assertBrainReader and nothing else', async () => {
    for (const channel of READER_CHANNELS) {
      const { handler, assertBrainReader, assertMainWindow } = setup()
      await Promise.resolve(handler(channel)(event, {})).catch(() => {})
      expect(assertBrainReader, channel).toHaveBeenCalledWith(event)
      expect(assertMainWindow, channel).not.toHaveBeenCalled()
    }
  })

  it('gates every privileged channel with assertMainWindow and nothing else', async () => {
    for (const channel of MAIN_WINDOW_CHANNELS) {
      const { handler, assertBrainReader, assertMainWindow } = setup()
      await Promise.resolve(handler(channel)(event, {})).catch(() => {})
      expect(assertMainWindow, channel).toHaveBeenCalledWith(event)
      expect(assertBrainReader, channel).not.toHaveBeenCalled()
    }
  })

  it('refuses a rejected sender before checking sign-in or touching the brain', async () => {
    const requireAuth = vi.fn(() => true)
    const { handler, assertMainWindow } = setup({ requireAuth })
    assertMainWindow.mockImplementation(() => {
      throw new Error('IPC denied: sender is not the main window')
    })
    await expect(
      Promise.resolve().then(() => handler(IPC.brainSetDealOutcome)(event, { dealSlug: 'a', outcome: 'won' }))
    ).rejects.toThrow('IPC denied')
    await expect(Promise.resolve().then(() => handler(IPC.brainRebuildAll)(event))).rejects.toThrow('IPC denied')
    expect(requireAuth).not.toHaveBeenCalled()
    expect(mocks.setDealOutcome).not.toHaveBeenCalled()
    expect(mocks.startRebuild).not.toHaveBeenCalled()
  })
})

describe('brain IPC auth gates', () => {
  it('returns the sign-in answers when signed out', async () => {
    const { handler } = setup({ requireAuth: () => false })
    expect(await handler(IPC.brainBackfill)(event)).toEqual({ ran: false, queued: 0, error: 'Sign in to index.' })
    expect(await handler(IPC.brainPreservedIndexesList)(event)).toEqual({ copies: [] })
    expect(await handler(IPC.brainEntityNames)(event)).toEqual({ names: [] })
    expect(await handler(IPC.brainAttention)(event)).toEqual({ items: [] })
    expect(await handler(IPC.brainMeetingExtraction)(event, {})).toBeNull()
    expect(await handler(IPC.brainSetDealOutcome)(event, { dealSlug: 'a', outcome: 'won' })).toEqual({
      ok: false,
      error: 'Sign in with your Mantu account first.'
    })
    expect(() => handler(IPC.brainIntelligencePass)(event)).toThrow('Not signed in.')
    await expect(Promise.resolve(handler(IPC.brainRead)(event))).rejects.toThrow('Not signed in.')
    expect(mocks.runIntelligenceIndex).not.toHaveBeenCalled()
    expect(mocks.setDealOutcome).not.toHaveBeenCalled()
  })
})

describe('brain IPC behaviour kept from the entry point', () => {
  it('resolves the deal through the alias map and audits a recorded outcome', async () => {
    const { handler } = setup()
    const result = await handler(IPC.brainSetDealOutcome)(event, { dealSlug: 'Big Deal', outcome: 'won' })
    expect(result).toEqual({ ok: true })
    expect(mocks.setDealOutcome).toHaveBeenCalledWith(settings, 'resolved-Big Deal', 'won')
    expect(mocks.markBrainChanged).toHaveBeenCalledWith(settings)
    expect(mocks.auditLog).toHaveBeenCalledWith('brain.deal.outcome', { outcome: 'won' })
  })

  it('reports invalid deal outcome input without writing', async () => {
    const { handler } = setup()
    const result = (await handler(IPC.brainSetDealOutcome)(event, { dealSlug: '', outcome: 'maybe' })) as {
      ok: boolean
    }
    expect(result.ok).toBe(false)
    expect(mocks.setDealOutcome).not.toHaveBeenCalled()
  })

  it('audits a user rebuild and an aborted rebuild separately', async () => {
    const { handler } = setup()
    await handler(IPC.brainRebuildAll)(event)
    expect(mocks.auditLog).toHaveBeenCalledWith('brain.backfill.start', { queued: 3, rebuild: true })
    mocks.startRebuild.mockResolvedValueOnce({ queued: 0, error: 'blocked' })
    expect(await handler(IPC.brainRebuildAll)(event)).toEqual({ queued: 0, error: 'blocked' })
    expect(mocks.auditLog).toHaveBeenCalledWith('brain.rebuild.aborted', {})
  })

  it('does not delete a preserved index copy unless the user confirms', async () => {
    const { handler } = setup({ showMessageBox: async () => ({ response: 1 }) })
    expect(await handler(IPC.brainPreservedIndexDelete)(event, { id: 'copy-1' })).toEqual({
      ok: false,
      error: 'cancelled'
    })
    expect(mocks.deletePreservedBrainIndex).not.toHaveBeenCalled()
  })

  it('deletes a confirmed preserved index copy and audits it', async () => {
    const { handler } = setup()
    expect(await handler(IPC.brainPreservedIndexDelete)(event, { id: 'copy-1' })).toEqual({ ok: true })
    expect(mocks.deletePreservedBrainIndex).toHaveBeenCalledWith(settings, 'copy-1')
    expect(mocks.auditLog).toHaveBeenCalledWith('brain.index.preserved_delete', { ok: true, error: undefined })
  })

  it('clear corruption lock asks first and cancel keeps the lock', async () => {
    const showMessageBox = vi.fn(async () => ({ response: 1 }))
    const { handler } = setup({ showMessageBox })
    expect(await handler(IPC.brainClearJournalCorruption)(event)).toEqual({ ok: false, error: 'cancelled' })
    expect(mocks.clearJournalCorruptionLock).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Resume corrections',
        message: 'Start a new corrections history?',
        buttons: ['Resume Corrections', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
    )
  })

  it('clears the corruption lock once the user confirms', async () => {
    const { handler } = setup()
    expect(await handler(IPC.brainClearJournalCorruption)(event)).toEqual({ ok: true, cleared: true })
    expect(mocks.clearJournalCorruptionLock).toHaveBeenCalledWith(settings)
    expect(mocks.auditLog).toHaveBeenCalledWith('brain.corrections.lock_cleared', { cleared: true })
  })

  it('opens the dashboard with no avoid rectangle when the overlay is gone', async () => {
    const { handler } = setup()
    await handler(IPC.brainOpenDashboard)(event)
    expect(mocks.openIntelligenceWindow).toHaveBeenCalledWith(undefined)
  })
})
