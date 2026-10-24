import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type PublicSettings } from '@shared/ipc'
import { RESPONSIVENESS_IPC, ResponsivenessReportSchema } from '@shared/responsiveness-metrics'
import {
  askTiming,
  createResponsivenessRecorder,
  setResponsivenessRecorderForTest
} from '../infra/observability/responsiveness-recorder'

const store = vi.hoisted(() => ({
  setSettings: vi.fn(),
  settings: {} as { teamTranscriptFolders?: string[] },
  locked: [] as string[]
}))
vi.mock('electron', () => ({}))
vi.mock('../store', () => ({
  getSettings: () => store.settings,
  getLockedKeys: () => store.locked,
  setSettings: store.setSettings
}))
vi.mock('../metrics', () => ({ readEvalMetrics: vi.fn(), aggregateMetrics: vi.fn() }))
vi.mock('../transcripts', () => ({ parseRecapMarkdown: vi.fn(), resolveMeetingsFolder: () => '/meetings' }))
vi.mock('../graphify', () => ({
  graphifyStatus: vi.fn(),
  buildGraph: vi.fn(),
  relatedNotes: vi.fn(),
  graphHtml: vi.fn()
}))
vi.mock('../brain/publish', () => ({ wikiDir: () => '/wiki' }))

import { registerWorkspaceIpc } from './workspace-ipc'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
const event = {} as IpcMainInvokeEvent
const snapshot = { resolvedMeetingsFolder: '/picked' } as PublicSettings

function setup(options: { auth?: boolean; picked?: string | null; writable?: boolean; readable?: boolean } = {}) {
  const handlers = new Map<string, Handler>()
  const assertMainWindow = vi.fn()
  const probeWritable = vi.fn(async () => options.writable ?? true)
  registerWorkspaceIpc({
    ipcMain: { handle: (channel: string, h: unknown) => void handlers.set(channel, h as Handler) } as Pick<
      IpcMain,
      'handle'
    >,
    assertMainWindow,
    requireAuth: () => options.auth ?? true,
    publicSettings: () => snapshot,
    showOpenDialog: vi.fn(async () =>
      options.picked === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [options.picked ?? '/picked'] }
    ),
    openPath: vi.fn(async () => ''),
    pathExists: () => true,
    probeWritable,
    canReadFolder: async () => options.readable ?? true
  })
  const pick = (): Promise<unknown> => (handlers.get(IPC.pickFolder) as Handler)(event)
  const addTeam = (): Promise<unknown> => (handlers.get(IPC.addTeamTranscriptFolder) as Handler)(event)
  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve((handlers.get(channel) as Handler)(event, ...args))
  return { assertMainWindow, probeWritable, pick, addTeam, call }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.settings = {}
  store.locked = []
})

describe('meetings folder picker (HIG: inline validation, last valid value kept)', () => {
  it('saves a writable folder and returns the new snapshot', async () => {
    const { pick, assertMainWindow, probeWritable } = setup()
    expect(await pick()).toEqual({ ok: true, settings: snapshot })
    expect(assertMainWindow).toHaveBeenCalledWith(event)
    expect(probeWritable).toHaveBeenCalledWith('/picked')
    expect(store.setSettings).toHaveBeenCalledWith({ meetingsFolder: '/picked' })
  })

  it('refuses a folder Métis cannot write to and leaves the setting alone', async () => {
    const { pick } = setup({ writable: false })
    expect(await pick()).toEqual({ ok: false, reason: 'not-writable' })
    expect(store.setSettings).not.toHaveBeenCalled()
  })

  it('reports a cancelled dialog and a signed-out caller without writing', async () => {
    expect(await setup({ picked: null }).pick()).toEqual({ ok: false, reason: 'cancelled' })
    const signedOut = setup({ auth: false })
    expect(await signedOut.pick()).toEqual({ ok: false, reason: 'signed-out' })
    expect(signedOut.probeWritable).not.toHaveBeenCalled()
    expect(store.setSettings).not.toHaveBeenCalled()
  })
})

describe('team transcript folder add (D9-10)', () => {
  it('saves a separate readable folder and returns the snapshot', async () => {
    const { addTeam } = setup({ picked: '/team' })
    expect(await addTeam()).toBe(snapshot)
    expect(store.setSettings).toHaveBeenCalledWith({ teamTranscriptFolders: ['/team'] })
  })

  it('team folder equal to the meetings folder is refused', async () => {
    const { addTeam } = setup({ picked: '/meetings' })
    expect(await addTeam()).toMatchObject({ ok: false, reason: 'overlaps-meetings' })
    expect(store.setSettings).not.toHaveBeenCalled()
  })

  it('refuses a folder nested in an existing team folder', async () => {
    store.settings = { teamTranscriptFolders: ['/team'] }
    const { addTeam } = setup({ picked: '/team/sub' })
    expect(await addTeam()).toMatchObject({ ok: false, reason: 'overlaps-team' })
    expect(store.setSettings).not.toHaveBeenCalled()
  })

  it('refuses an unreadable folder', async () => {
    const { addTeam } = setup({ picked: '/team', readable: false })
    expect(await addTeam()).toMatchObject({ ok: false, reason: 'not-readable' })
    expect(store.setSettings).not.toHaveBeenCalled()
  })

  it('says so when a managed policy locks the list, instead of returning a success-looking snapshot', async () => {
    store.locked = ['teamTranscriptFolders']
    const { addTeam } = setup({ picked: '/team' })
    expect(await addTeam()).toMatchObject({ ok: false, reason: 'managed' })
    expect(store.setSettings).not.toHaveBeenCalled()
  })

  it('keeps cancelled and signed-out as the unchanged snapshot', async () => {
    expect(await setup({ picked: null }).addTeam()).toBe(snapshot)
    expect(await setup({ auth: false }).addTeam()).toBe(snapshot)
    expect(store.setSettings).not.toHaveBeenCalled()
  })
})

describe('responsiveness report and display receipt (G12)', () => {
  const identity = { platform: 'darwin', arch: 'arm64', appVersion: '0.0.0-test' }
  afterEach(() => setResponsivenessRecorderForTest(null))

  function useRecorder() {
    let t = 1_000
    const rec = createResponsivenessRecorder({ identity, now: () => t })
    setResponsivenessRecorderForTest(rec)
    return { rec, advance: (ms: number) => void (t += ms) }
  }

  it('returns the report, gated on the main window and on sign-in', async () => {
    const { rec } = useRecorder()
    rec.recordLatency('first_partial_ms', 480)
    const ok = setup()
    const report = ResponsivenessReportSchema.parse(await ok.call(RESPONSIVENESS_IPC.report))
    expect(ok.assertMainWindow).toHaveBeenCalledWith(event)
    expect(report.entries.find((e) => e.id === 'first_partial_ms')).toMatchObject({ status: 'measured', count: 1 })

    const signedOut = setup({ auth: false })
    const empty = ResponsivenessReportSchema.parse(await signedOut.call(RESPONSIVENESS_IPC.report))
    expect(empty.entries.every((e) => e.status === 'not_measured')).toBe(true)
  })

  it('takes a display receipt only from the main window, signed in, for a bounded ask id', async () => {
    const { rec, advance } = useRecorder()
    askTiming.start('ask-1', 'suggest')
    advance(900)
    askTiming.firstVisible('ask-1')
    advance(40)

    const signedOut = setup({ auth: false })
    await signedOut.call(RESPONSIVENESS_IPC.displayReceipt, 'ask-1')
    expect(rec.snapshot().counters.suggestions_displayed).toBeUndefined()

    const ok = setup()
    for (const junk of [42, '', '   ', 'x'.repeat(129), { id: 'ask-1' }, null, undefined]) {
      await ok.call(RESPONSIVENESS_IPC.displayReceipt, junk)
    }
    expect(rec.snapshot().counters.suggestions_displayed).toBeUndefined()

    await ok.call(RESPONSIVENESS_IPC.displayReceipt, 'ask-1')
    expect(ok.assertMainWindow).toHaveBeenCalledWith(event)
    expect(rec.snapshot().counters.suggestions_displayed).toBe(1)
    expect(rec.snapshot().latencies.display_receipt_ms).toEqual([40])
  })

  function displayed(id: string, advance: (ms: number) => void): void {
    askTiming.start(id, 'suggest')
    advance(10)
    askTiming.firstVisible(id)
    askTiming.displayed(id)
  }

  it('card-outcome rejects a non-main sender', async () => {
    const { rec, advance } = useRecorder()
    displayed('ask-1', advance)
    const bad = setup()
    bad.assertMainWindow.mockImplementation(() => {
      throw new Error('not the main window')
    })
    expect(() => bad.call(RESPONSIVENESS_IPC.cardOutcome, 'ask-1', 'review_expired')).toThrow('not the main window')
    expect(rec.snapshot().counters.card_review_expired).toBeUndefined()
  })

  it('card-outcome ignores unauthenticated calls', async () => {
    const { rec, advance } = useRecorder()
    displayed('ask-1', advance)
    await setup({ auth: false }).call(RESPONSIVENESS_IPC.cardOutcome, 'ask-1', 'review_expired')
    expect(rec.snapshot().counters.card_review_expired).toBeUndefined()
  })

  it('card-outcome ignores an unknown outcome or malformed id, and counts a valid one once', async () => {
    const { rec, advance } = useRecorder()
    displayed('ask-1', advance)
    const ok = setup()
    for (const [id, outcome] of [
      ['ask-1', 'something_else'],
      ['ask-1', 42],
      ['ask-1', undefined],
      [42, 'review_expired'],
      ['', 'review_expired'],
      ['x'.repeat(129), 'review_expired']
    ]) {
      await ok.call(RESPONSIVENESS_IPC.cardOutcome, id, outcome)
    }
    expect(rec.snapshot().counters.card_review_expired).toBeUndefined()
    await ok.call(RESPONSIVENESS_IPC.cardOutcome, 'ask-1', 'review_expired')
    await ok.call(RESPONSIVENESS_IPC.cardOutcome, 'ask-1', 'review_expired')
    expect(rec.snapshot().counters.card_review_expired).toBe(1)
  })
})
