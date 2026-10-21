import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type PublicSettings } from '@shared/ipc'

const store = vi.hoisted(() => ({ setSettings: vi.fn() }))
vi.mock('electron', () => ({}))
vi.mock('../store', () => ({ getSettings: () => ({}), setSettings: store.setSettings }))
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

function setup(options: { auth?: boolean; picked?: string | null; writable?: boolean } = {}) {
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
    probeWritable
  })
  const pick = (): Promise<unknown> => (handlers.get(IPC.pickFolder) as Handler)(event)
  return { assertMainWindow, probeWritable, pick }
}

beforeEach(() => vi.clearAllMocks())

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
