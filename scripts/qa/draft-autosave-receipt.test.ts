import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC, type SaveDraftTranscriptResult, type SaveMeeting, type Settings } from '@shared/ipc'
import { saveDraftTranscript } from '../../src/main/transcripts'
import { useStorageForTests } from '../../src/main/infra/storage/meetings-storage'
import { startDraftAutosave } from '../../src/renderer/src/lib/draft-autosave'
import { SpeechAuthLeaseController, type SpeechAuthSession } from '../../src/main/auth-speech-lease'
import { captureDraftSettingsBoundary, publishSettingsSnapshot } from '../../src/main/settings-observation'
import { registerDraftTranscriptIpc } from '../../src/main/ipc/draft-transcript-ipc'
import type { TotoApi } from '../../src/preload'
import '../../src/preload'

const electronBoundary = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: TotoApi) => void>(),
  invoke: vi.fn<(channel: string, payload: unknown) => Promise<unknown>>()
}))

vi.mock('electron', async () => {
  const existing = await import('../../__mocks__/electron')
  return {
    ...existing,
    contextBridge: { exposeInMainWorld: electronBoundary.expose },
    ipcRenderer: {
      invoke: electronBoundary.invoke,
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn()
    },
    webUtils: { getPathForFile: vi.fn() }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(async (from: string, to: string) => renameSync(from, to))
  }
})

function exposedDraftBridge(): TotoApi['saveDraftTranscript'] {
  expect(electronBoundary.expose).toHaveBeenCalledTimes(1)
  const exposed = electronBoundary.expose.mock.calls.filter(([name]) => name === 'toto')
  expect(exposed).toHaveLength(1)
  const api = exposed[0]?.[1]
  if (!api || typeof api.saveDraftTranscript !== 'function') throw new Error('Actual preload did not expose draft save')
  return api.saveDraftTranscript
}

describe('actual exposed draft preload transport', () => {
  const payload: SaveMeeting = {
    mode: 'meeting',
    title: 'Synthetic draft transport',
    startedAt: 1,
    lines: [],
    recap: ''
  }
  beforeEach(() => {
    electronBoundary.invoke.mockReset()
  })
  afterEach(() => {
    electronBoundary.invoke.mockReset()
  })

  it.each<SaveDraftTranscriptResult>([
    { status: 'saved' },
    { status: 'failed' },
    { status: 'disabled' }
  ])('forwards the exact payload and unchanged %s receipt through the exposed preload', async (receipt) => {
    const result = Promise.resolve(receipt)
    electronBoundary.invoke.mockReturnValueOnce(result)
    const pending = exposedDraftBridge()(payload)
    expect(pending).toBe(result)
    await expect(pending).resolves.toBe(receipt)
    expect(electronBoundary.invoke).toHaveBeenCalledExactlyOnceWith(IPC.saveDraftTranscript, payload)
    expect(electronBoundary.invoke.mock.calls[0]?.[1]).toBe(payload)
  })

  it.each([
    undefined,
    null,
    new Error('Synthetic private preload refusal')
  ])('preserves an external invoke rejection without claiming saved (%s)', async (refusal) => {
    electronBoundary.invoke.mockRejectedValueOnce(refusal)
    await expect(exposedDraftBridge()(payload)).rejects.toBe(refusal)
    expect(electronBoundary.invoke).toHaveBeenCalledExactlyOnceWith(IPC.saveDraftTranscript, payload)
  })
})

// The actual index registration and all seven disconnected-wiring negatives remain in rebuild-waves.
// This path imports the exposed preload, registered draft handler and consumed renderer lifecycle,
// retaining real snapshot IO and failure feedback without executing source fragments or main boot.
describe('draft receipt reaches the renderer through the imported draft registrar and actual preload', () => {
  let folder: string
  let settings: Settings
  let actualFs: typeof import('node:fs/promises')
  let activeHost: symbol | undefined

  beforeEach(async () => {
    expect(activeHost).toBeUndefined()
    electronBoundary.invoke.mockReset()
    useStorageForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-draft-receipt-'))
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    publishSettingsSnapshot(settings, true)
    actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(writeFile).mockImplementation(actualFs.writeFile)
    vi.mocked(rename).mockImplementation(async (from, to) => renameSync(from, to))
  })

  afterEach(() => {
    activeHost = undefined
    electronBoundary.invoke.mockReset()
    vi.restoreAllMocks()
    rmSync(folder, { recursive: true, force: true })
  })

  function host(authenticated = true) {
    if (activeHost) throw new Error('The previous draft transport host must be cleaned up before replacement')
    const owner = Symbol('draft transport host')
    let handler!: (event: unknown, payload: unknown) => Promise<unknown>
    let backend = saveDraftTranscript
    let senderFailure: Error | undefined
    const newSession = (): SpeechAuthSession => ({
      email: 'synthetic@example.invalid',
      domain: 'example.invalid',
      tid: 'synthetic-tenant',
      at: 1
    })
    let session: SpeechAuthSession | null = newSession()
    let sessionEpoch = 0
    let profile = folder
    let canRead = true
    let onSettingsRead = () => {}
    let onAuthorize = () => {}
    const requireAuth = () => {
      onAuthorize()
      return authenticated
    }
    const auth = new SpeechAuthLeaseController({
      prepareSession: () => {},
      readSession: () => session,
      readSessionEpoch: () => sessionEpoch,
      readProfilePath: () => profile,
      readBoundary: async () => null,
      validateSession: () => {},
      sessionIsValid: () => true
    })
    const registered: string[] = []
    const dependencies: Parameters<typeof registerDraftTranscriptIpc>[0] = {
      saveDraftTranscript: (...args: Parameters<typeof saveDraftTranscript>) => backend(...args),
      assertMainWindow: () => {
        if (senderFailure) throw senderFailure
      },
      requireAuth,
      captureAuthSessionBoundary: () => auth.captureSessionBoundary(requireAuth),
      captureDraftSettingsBoundary,
      ipcMain: {
        handle(channel, callback) {
          expect(channel).toBe(IPC.saveDraftTranscript)
          registered.push(channel)
          handler = (event, payload) => Promise.resolve(callback(event as IpcMainInvokeEvent, payload))
        }
      },
      getSettings: () => {
        onSettingsRead()
        publishSettingsSnapshot(settings, canRead)
        return settings
      }
    }
    registerDraftTranscriptIpc(dependencies)
    expect(registered).toEqual([IPC.saveDraftTranscript])
    electronBoundary.invoke.mockImplementation((channel, payload) => {
      if (channel !== IPC.saveDraftTranscript || activeHost !== owner) {
        return Promise.reject(new Error('Draft preload invoked an unregistered transport channel'))
      }
      return handler({}, payload)
    })
    const bridge = exposedDraftBridge()
    let tick!: () => void
    let pending: Promise<SaveDraftTranscriptResult> | undefined
    const calls: unknown[] = []
    const save = vi.fn((payload: SaveMeeting) => {
      pending = bridge(payload).then((result) => {
        calls.push(result)
        return result
      })
      return pending
    })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      tick = callback as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    })
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    const context = {
      listen: { listening: true },
      mode: 'meeting',
      meetingStartRef: { current: 1_700_000_000_000 },
      autosaveLinesRef: {
        current: [
          { speaker: 'them' as const, text: 'Synthetic final speech.', t: 1_700_000_000_000 },
          { speaker: 'them' as const, text: 'Synthetic provisional.', t: 1_700_000_000_001, provisional: true }
        ]
      },
      autosaveFailsRef: { current: 0 },
      setAutosaveWarn: vi.fn(),
      defaultMeetingTitle: () => 'Synthetic meeting'
    }
    activeHost = owner
    const stop = startDraftAutosave({
      mode: 'meeting',
      getLines: () => context.autosaveLinesRef.current,
      getStartedAt: () => context.meetingStartRef.current,
      title: context.defaultMeetingTitle,
      failures: context.autosaveFailsRef,
      warn: context.setAutosaveWarn,
      save
    })
    const cleanup = () => {
      try {
        stop()
      } finally {
        setIntervalSpy.mockRestore()
        clearIntervalSpy.mockRestore()
        if (activeHost === owner) {
          activeHost = undefined
          electronBoundary.invoke.mockReset()
        }
      }
    }
    return {
      context,
      calls,
      handler,
      cleanup,
      denySender(failure: Error) {
        senderFailure = failure
      },
      rejectBackend(failure: unknown) {
        backend = () => Promise.reject(failure)
      },
      renew() {
        authenticated = true
        session = newSession()
        sessionEpoch += 1
        profile = folder
      },
      revoke() {
        authenticated = false
        session = null
        sessionEpoch += 1
      },
      replaceSession() {
        session = { ...session! }
        sessionEpoch += 1
      },
      resetProfileEpoch() {
        sessionEpoch += 1
      },
      moveProfile() {
        profile = `${folder}-other`
      },
      onSettingsRead(callback: () => void) {
        onSettingsRead = callback
      },
      onAuthorize(callback: () => void) {
        onAuthorize = callback
      },
      setReadable(value: boolean) {
        canRead = value
      },
      async tick() {
        tick()
        await pending
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }

  it('reports real write failures, retains warning on policy-disabled receipts and clears on saved', async () => {
    const h = host()
    try {
      vi.mocked(rename).mockRejectedValue(Object.assign(new Error('Synthetic private path'), { code: 'EIO' }))
      await h.tick()
      await h.tick()
      expect(h.calls).toEqual([{ status: 'failed' }, { status: 'failed' }])
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(true)
      settings = {
        ...settings,
        enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
      } as Settings
      h.context.setAutosaveWarn.mockClear()
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'disabled' })
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).not.toHaveBeenCalled()
      settings = { ...settings, enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false } }
      vi.mocked(rename).mockImplementation(async (from, to) => renameSync(from, to))
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'saved' })
      expect(h.context.autosaveFailsRef.current).toBe(0)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(false)
      const draft = readdirSync(folder).find((file) => file.startsWith('.autosave-draft-'))!
      const bytes = readFileSync(join(folder, draft), 'utf8')
      expect(bytes).toContain('Synthetic final speech.')
      expect(bytes).not.toContain('Synthetic provisional.')
    } finally {
      h.cleanup()
    }
  })

  it('retains the actual sender validation before any snapshot IO', async () => {
    const h = host()
    const refusal = new Error('Synthetic private sender canary')
    try {
      h.denySender(refusal)
      await expect(h.handler({}, {})).rejects.toBe(refusal)
      expect(readdirSync(folder)).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  it('does not acknowledge unauthenticated or malformed requests as saved', async () => {
    const denied = host(false)
    try {
      await denied.tick()
      expect(denied.calls).toEqual([{ status: 'failed' }])
    } finally {
      denied.cleanup()
    }
    const admitted = host()
    try {
      await expect(admitted.handler({}, {})).resolves.toEqual({ status: 'failed' })
    } finally {
      admitted.cleanup()
    }
    expect(readdirSync(folder)).toEqual([])
  })

  async function duringOwnedTemp(h: ReturnType<typeof host>, transition: () => void): Promise<void> {
    let release!: () => void
    let didWrite!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const written = new Promise<void>((resolve) => {
      didWrite = resolve
    })
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      await actualFs.writeFile(...args)
      didWrite()
      await gate
    })
    const pending = h.tick()
    try {
      await Promise.race([
        written,
        pending.then(() => {
          throw new Error('Draft settled before owned temporary write')
        })
      ])
      expect(readdirSync(folder).some((file) => file.endsWith('.tmp'))).toBe(true)
      expect(vi.mocked(writeFile).mock.lastCall?.[2]).toEqual({ mode: 0o600 })
      transition()
    } finally {
      release()
      await pending
    }
  }

  it.each([
    'session revocation',
    'session replacement',
    'profile reset epoch',
    'profile path',
    'root ABA',
    'encryption ABA',
    'retention ABA',
    'auth configuration ABA',
    'readability ABA'
  ])('refuses stale %s publication, preserves old bytes, and reaches the existing warning privately', async (kind) => {
    const h = host()
    try {
      await h.tick()
      const draft = readdirSync(folder).find((file) => file.startsWith('.autosave-draft-'))!
      const oldFiles = readdirSync(folder)
      const oldBytes = readFileSync(join(folder, draft))
      h.calls.length = 0
      h.context.autosaveLinesRef.current[0].text = 'Synthetic private stale content canary.'
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // Each request starts with a valid owner, then loses its captured authority before replacement.
        h.renew()
        await duringOwnedTemp(h, () => {
          if (kind === 'session revocation') h.revoke()
          else if (kind === 'session replacement') h.replaceSession()
          else if (kind === 'profile reset epoch') h.resetProfileEpoch()
          else if (kind === 'profile path') h.moveProfile()
          else {
            const change =
              kind === 'root ABA'
                ? { meetingsFolder: `${folder}-private-canary` }
                : kind === 'encryption ABA'
                  ? { encryptTranscripts: true }
                  : kind === 'retention ABA'
                    ? { enterpriseLive: { managed: true, inferenceMode: 'cloud-only' as const, summaryOnly: true } }
                    : { azureTenantId: 'synthetic-private-tenant-canary' }
            if (kind === 'readability ABA') publishSettingsSnapshot(settings, false)
            else publishSettingsSnapshot({ ...settings, ...change }, true)
            publishSettingsSnapshot(settings, true)
          }
        })
        expect(readFileSync(join(folder, draft))).toEqual(oldBytes)
        expect(readdirSync(folder)).toEqual(oldFiles)
      }
      expect(h.calls).toEqual([{ status: 'failed' }, { status: 'failed' }])
      expect(h.context.autosaveFailsRef.current).toBe(2)
      expect(h.context.setAutosaveWarn).toHaveBeenLastCalledWith(true)
      expect(JSON.stringify(h.calls)).not.toContain('canary')
    } finally {
      h.cleanup()
    }
  })

  it('allows equivalent and unrelated publications, then a new current save after a refused ABA', async () => {
    const h = host()
    try {
      await duringOwnedTemp(h, () => {
        settings = { ...settings, autoSaveTranscripts: true }
        publishSettingsSnapshot(settings, true)
      })
      expect(h.calls.at(-1)).toEqual({ status: 'saved' })
      await duringOwnedTemp(h, () => {
        publishSettingsSnapshot({ ...settings, encryptTranscripts: true }, true)
        publishSettingsSnapshot(settings, true)
      })
      expect(h.calls.at(-1)).toEqual({ status: 'failed' })
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'saved' })
    } finally {
      h.cleanup()
    }
  })

  it('captures auth before settings publication and checks settings after reentrant authorization', async () => {
    const h = host()
    try {
      h.onSettingsRead(() => {
        h.replaceSession()
      })
      await h.tick()
      expect(h.calls.at(-1)).toEqual({ status: 'failed' })
      h.onSettingsRead(() => {})
      await duringOwnedTemp(h, () => {
        h.onAuthorize(() => {
          publishSettingsSnapshot({ ...settings, encryptTranscripts: true }, true)
          publishSettingsSnapshot(settings, true)
        })
      })
      expect(h.calls.at(-1)).toEqual({ status: 'failed' })
    } finally {
      h.cleanup()
    }
  })

  it('refuses initially unreadable settings without reporting a saved draft', async () => {
    const h = host()
    try {
      h.setReadable(false)
      await h.tick()
      expect(h.calls).toEqual([{ status: 'failed' }])
      // Existing folder scaffolding may precede admission; no stale draft is published.
      expect(readdirSync(folder).some((file) => file.startsWith('.autosave-draft-') || file.endsWith('.tmp'))).toBe(
        false
      )
    } finally {
      h.cleanup()
    }
  })

  it.each([
    undefined,
    null,
    new Error('Synthetic private backend canary')
  ])('preserves unrelated backend rejection identity (%s)', async (failure) => {
    const h = host()
    try {
      h.rejectBackend(failure)
      await expect(
        h.handler({}, { mode: 'meeting', title: 'Synthetic', startedAt: 1, lines: [], recap: '' })
      ).rejects.toBe(failure)
    } finally {
      h.cleanup()
    }
  })
})
