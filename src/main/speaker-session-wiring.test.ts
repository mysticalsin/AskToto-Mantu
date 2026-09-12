import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

import { LiveMeetingStartedAtSchema } from '@shared/ipc'
import { createListeningStateHandler } from './listening-state-ipc'
import {
  createSpeakerId,
  type SpeakerEnrollmentSnapshot,
  type SpeakerId
} from './speaker-id'

const indexText = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const indexSource = ts.createSourceFile('index.ts', indexText, ts.ScriptTarget.Latest, true)

function runSource(sourceText: string, globals: Record<string, unknown>): any {
  const compiled = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext({
    Map,
    Set,
    Date,
    Promise,
    Float32Array,
    Object,
    console,
    ...globals
  })
  vm.runInContext(compiled, context, { timeout: 2_000 })
  return context.result
}

function actualFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const declaration = indexSource.statements.find(
    node => ts.isFunctionDeclaration(node) && node.name?.text === name
  )
  expect(declaration, `Actual source function ${name} was not found`).toBeDefined()
  if (!declaration) return () => undefined
  return runSource(`${declaration.getText(indexSource)}\nglobalThis.result = ${name};`, globals)
}

function actualIpcHandler(channel: string, globals: Record<string, unknown>): (...args: any[]) => any {
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(indexSource) === 'ipcMain' &&
      node.expression.name.text === 'handle' &&
      node.arguments[0]?.getText(indexSource) === `IPC.${channel}`
    ) callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  expect(callback, `Actual IPC.${channel} handler was not found`).toBeDefined()
  if (!callback) return () => undefined
  return runSource(`globalThis.result = (${callback.getText(indexSource)});`, globals)
}

function actualRendererGoneHandler(globals: Record<string, unknown>): (...args: any[]) => any {
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(indexSource) === 'win.webContents' &&
      node.expression.name.text === 'on' &&
      node.arguments[0]?.getText(indexSource) === "'render-process-gone'"
    ) callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  expect(callback, 'Actual overlay render-process-gone handler was not found').toBeDefined()
  if (!callback) return () => undefined
  return runSource(`globalThis.result = (${callback.getText(indexSource)});`, globals)
}

interface SessionApi {
  acceptLiveSpeakerTransition(change: { on: boolean; startedAt?: number }): boolean
  captureLiveSpeakerKey(startedAt: unknown): string | null
  recordLiveSpeakerSave(startedAt: number, file: string): boolean
  discardActiveLiveSpeakerSession(): void
  labelThemAudio(samples: Float32Array, key: string | null, owner: 'live' | 'import'): Promise<any>
  observeOperatorAudio(samples: Float32Array, key: string | null): Promise<void>
  applySpeakerIdPolicy(enabled: boolean): boolean
  beginImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): boolean
  captureImportSpeakerKey(attempt: { readonly jobId: string; readonly attemptId: number }): string | null
  finalizeImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): Map<string, string> | null
  disposeImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): void
}

function sessionApi(options: {
  id: SpeakerId
  enabled?: () => boolean
  now?: () => number
  backfill?: (file: string, snapshot?: SpeakerEnrollmentSnapshot) => Promise<unknown>
}): SessionApi {
  const start = indexText.indexOf('// --- Speaker session ownership (Task 7-P2b) ---')
  const end = indexText.indexOf('// --- End speaker session ownership ---')
  expect(start, 'Speaker session ownership region start was not found').toBeGreaterThanOrEqual(0)
  expect(end, 'Speaker session ownership region end was not found').toBeGreaterThan(start)
  if (start < 0 || end <= start) throw new Error('Speaker session ownership implementation is absent')
  const region = indexText.slice(start, end)
  return runSource(`${region}\nglobalThis.result = {
    acceptLiveSpeakerTransition,
    captureLiveSpeakerKey,
    recordLiveSpeakerSave,
    discardActiveLiveSpeakerSession,
    labelThemAudio,
    observeOperatorAudio,
    applySpeakerIdPolicy,
    beginImportSpeakers,
    captureImportSpeakerKey,
    finalizeImportSpeakers,
    disposeImportSpeakers
  };`, {
    createSpeakerId: () => options.id,
    getSettings: () => ({ speakerId: { enabled: options.enabled?.() ?? true } }),
    LiveMeetingStartedAtSchema,
    Date: class extends Date { static now(): number { return options.now?.() ?? Date.now() } },
    backfillSpeakerNames: options.backfill ?? (async () => ({ ok: true, named: 0 })),
    mainLog: { warn: vi.fn(), error: vi.fn() }
  })
}

function embeddingFor(axis: number): Float32Array {
  const embedding = new Float32Array(8)
  embedding[axis] = 1
  embedding[7] = 0.1
  return embedding
}

function windowFor(axis: number): Float32Array {
  return Float32Array.from([axis])
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'speaker-session-wiring-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function realSpeakerId(
  compute: (samples: Float32Array) => Promise<Float32Array | null> = async samples =>
    samples.length ? embeddingFor(Math.round(samples[0])) : null
): SpeakerId {
  return createSpeakerId({
    createExtractor: () => ({ compute }),
    storePath: () => join(dir, 'voiceprints.json')
  })
}

function feedHandler(
  channel: 'parakeetFeed' | 'appleSpeechFeed' | 'speakerEmbed',
  api: SessionApi,
  transcribe: (samples: Float32Array) => Promise<string> = async () => 'transcribed'
): (...args: any[]) => Promise<any> {
  return actualIpcHandler(channel, {
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    takeHotPath: () => true,
    parakeetTranscribe: transcribe,
    appleSpeechTranscribe: transcribe,
    appleSpeechLocale: () => 'en-US',
    getSettings: () => ({ asrLanguage: 'auto' }),
    captureLiveSpeakerKey: api.captureLiveSpeakerKey,
    labelThemAudio: api.labelThemAudio,
    observeOperatorAudio: api.observeOperatorAudio
  })
}

function saveHandler(api: SessionApi, file = '/meetings/meeting-a.md'): (...args: any[]) => Promise<any> {
  return actualIpcHandler('saveTranscript', {
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    takeHotPath: () => true,
    SaveMeetingSchema: { parse: (value: unknown) => value },
    stripProvisionalLines: (lines: unknown) => lines,
    saveMeeting: async () => file,
    getSettings: () => ({ brainConsolidation: { enabled: false }, encryptTranscripts: false }),
    recordMeetingSummarized: vi.fn(),
    meetingDurationMin: () => 1,
    wordsFromTexts: () => [],
    estimateNoteTakingMinutes: () => 0,
    appendTimeSavedEvent: vi.fn(),
    clearDraftTranscript: async () => undefined,
    auditLog: vi.fn(),
    scheduleRebuild: vi.fn(),
    enqueueIngest: async () => undefined,
    recordLiveSpeakerSave: api.recordLiveSpeakerSave,
    backfillSpeakerNames: vi.fn(async () => ({ ok: true, named: 0 }))
  })
}

describe('authoritative live speaker identity', () => {
  it('wires the actual listening registration to the single index transition authority', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const tray = vi.fn()
    const power = vi.fn()
    const releaseParakeet = vi.fn(async () => undefined)
    const releaseSpeakerEmbedding = vi.fn(async () => undefined)
    const speakerIdProcessingEnabled = vi.fn(() => false)
    const handler = actualIpcHandler('listeningState', {
      createListeningStateHandler,
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      acceptLiveSpeakerTransition: api.acceptLiveSpeakerTransition,
      listeningActive: false,
      setTrayRecording: tray,
      setRecordingPowerSaveBlock: power,
      parakeetRelease: releaseParakeet,
      releaseSpeakerEmbedding,
      resetDustConversation: vi.fn(),
      getSettings: () => ({ providerModels: {}, dustWorkspaceId: '', dustBaseUrl: '' }),
      getApiKey: () => '',
      prewarmDustConversation: vi.fn(),
      speakerIdProcessingEnabled,
      speakerIdInstance: {}
    })

    await handler({}, { on: true, startedAt: 100 })
    await handler({}, { on: true, startedAt: 200 })
    await handler({}, { on: false, startedAt: 100 })
    expect(tray.mock.calls.map(([on]) => on)).toEqual([true, true])
    expect(power.mock.calls.map(([on]) => on)).toEqual([true, true])
    expect(releaseParakeet).not.toHaveBeenCalled()

    await handler({}, { on: false, startedAt: 200 })
    expect(tray.mock.calls.map(([on]) => on)).toEqual([true, true, false])
    expect(releaseParakeet).toHaveBeenCalledTimes(1)
    expect(releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
  })

  it('rejects a delayed older start and stale stop while the newer keyed owner stays active', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    const setListeningActive = vi.fn()
    const releaseParakeet = vi.fn(async () => undefined)
    const releaseSpeakerEmbedding = vi.fn(async () => undefined)
    const handler = createListeningStateHandler({
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      acceptTransition: api.acceptLiveSpeakerTransition,
      setListeningActive,
      setTrayRecording: vi.fn(),
      setRecordingPowerSaveBlock: vi.fn(),
      onMeetingStart: vi.fn(),
      releaseParakeet,
      releaseSpeakerEmbedding
    })

    await handler({}, { on: true, startedAt: 100 })
    await handler({}, { on: true, startedAt: 200 })
    await handler({}, { on: false, startedAt: 100 })
    await handler({}, { on: true, startedAt: 150 })

    expect(api.captureLiveSpeakerKey(200)).toBe('live:200')
    expect(api.captureLiveSpeakerKey(100)).toBeNull()
    expect(setListeningActive.mock.calls.map(([on]) => on)).toEqual([true, true])
    expect(releaseParakeet).not.toHaveBeenCalled()

    await handler({}, { on: false, startedAt: 200 })
    expect(setListeningActive.mock.calls.map(([on]) => on)).toEqual([true, true, false])
    expect(releaseParakeet).toHaveBeenCalledTimes(1)
    expect(releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy capture compatible without letting legacy state control a keyed meeting', () => {
    const api = sessionApi({ id: realSpeakerId() })
    expect(api.acceptLiveSpeakerTransition({ on: true })).toBe(true)
    expect(api.captureLiveSpeakerKey(undefined)).toBeNull()
    expect(api.acceptLiveSpeakerTransition({ on: false })).toBe(true)
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 300 })).toBe(true)
    expect(api.acceptLiveSpeakerTransition({ on: false })).toBe(false)
    expect(api.acceptLiveSpeakerTransition({ on: true })).toBe(false)
    expect(api.captureLiveSpeakerKey(300)).toBe('live:300')
  })

  it('retains capture ownership but revokes every speaker continuation when privacy turns off', async () => {
    let enabled = true
    const id = realSpeakerId()
    const api = sessionApi({ id, enabled: () => enabled })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 400 })).toBe(true)
    expect(api.captureLiveSpeakerKey(400)).toBe('live:400')

    enabled = false
    expect(api.applySpeakerIdPolicy(false)).toBe(false)
    enabled = true

    expect(api.captureLiveSpeakerKey(400)).toBeNull()
    expect(api.acceptLiveSpeakerTransition({ on: false, startedAt: 400 })).toBe(true)
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 400 })).toBe(false)
  })
})

describe('live feed identity routing', () => {
  it.each(['parakeetFeed', 'appleSpeechFeed'] as const)(
    '%s captures A before ASR await so delayed A work cannot seed B',
    async channel => {
      const id = realSpeakerId()
      const api = sessionApi({ id })
      api.acceptLiveSpeakerTransition({ on: true, startedAt: 100 })
      let resolveA!: (text: string) => void
      const transcribe = vi.fn((samples: Float32Array) => samples[0] === 0
        ? new Promise<string>(resolve => { resolveA = resolve })
        : Promise.resolve('meeting B'))
      const handler = feedHandler(channel, api, transcribe)

      const pendingA = handler({}, { samples: windowFor(0), speaker: 'them', startedAt: 100 })
      await Promise.resolve()
      api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
      resolveA('meeting A')

      await expect(pendingA).resolves.toMatchObject({ text: 'meeting A' })
      await expect(handler({}, { samples: windowFor(1), speaker: 'them', startedAt: 200 }))
        .resolves.toEqual({ text: 'meeting B', name: 'Speaker 1' })
    }
  )

  it.each(['parakeetFeed', 'appleSpeechFeed'] as const)(
    '%s preserves ASR text and performs no speaker work for stale, missing, or malformed identity',
    async channel => {
      const id = realSpeakerId()
      const api = sessionApi({ id })
      api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
      const handler = feedHandler(channel, api)

      for (const startedAt of [100, undefined, 0, '200']) {
        await expect(handler({}, { samples: windowFor(0), speaker: 'them', startedAt }))
          .resolves.toEqual({ text: 'transcribed' })
      }
      await expect(handler({}, { samples: windowFor(1), speaker: 'them', startedAt: 200 }))
        .resolves.toEqual({ text: 'transcribed', name: 'Speaker 1' })
    }
  )

  it('speakerEmbed preserves its empty shape and cannot observe or echo-drop without exact identity', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
    const handler = feedHandler('speakerEmbed', api)

    for (let i = 0; i < 3; i++) {
      await expect(handler({}, { samples: windowFor(2), speaker: 'you' })).resolves.toEqual({})
    }
    await expect(handler({}, { samples: windowFor(2), speaker: 'them', startedAt: 100 })).resolves.toEqual({})
    await expect(handler({}, { samples: windowFor(2), speaker: 'them', startedAt: 200 }))
      .resolves.toEqual({ name: 'Speaker 1' })
  })

  it.each(['false', 'throw'] as const)('speaker admission %s keeps ASR text and never falls back to legacy state', async mode => {
    const fake = {
      createSession: vi.fn(() => {
        if (mode === 'throw') throw new Error('capacity unavailable')
        return false
      }),
      labelSessionWindow: vi.fn(),
      observeSessionOperatorWindow: vi.fn(),
      labelWindow: vi.fn(),
      observeOperatorWindow: vi.fn(),
      resetSession: vi.fn(),
      discardSession: vi.fn()
    } as unknown as SpeakerId
    const api = sessionApi({ id: fake })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 500 })).toBe(true)

    const handler = feedHandler('parakeetFeed', api)
    await expect(handler({}, { samples: windowFor(0), speaker: 'them', startedAt: 500 }))
      .resolves.toEqual({ text: 'transcribed' })
    expect(fake.labelSessionWindow).not.toHaveBeenCalled()
    expect(fake.labelWindow).not.toHaveBeenCalled()
    expect(fake.resetSession).not.toHaveBeenCalled()
  })
})

describe('bounded close and successful-save receipt join', () => {
  it('defers active and duplicate saves, then snapshots and backfills the exact file once on Stop', async () => {
    const backfill = vi.fn(async (_file: string, _snapshot?: SpeakerEnrollmentSnapshot) => ({ ok: true, named: 1 }))
    const id = realSpeakerId()
    const api = sessionApi({ id, backfill })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 600 })
    for (let i = 0; i < 3; i++) await api.labelThemAudio(windowFor(3), 'live:600', 'live')

    const save = saveHandler(api)
    const meeting = { startedAt: 600, lines: [], recap: '', mode: 'meeting' }
    await save({}, meeting)
    await save({}, meeting)
    expect(backfill).not.toHaveBeenCalled()

    expect(api.acceptLiveSpeakerTransition({ on: false, startedAt: 600 })).toBe(true)
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1))
    expect(backfill.mock.calls[0]?.[0]).toBe('/meetings/meeting-a.md')
    expect(backfill.mock.calls[0]?.[1]).toBeTruthy()
    expect(id.snapshotSession('live:600')).toBeNull()
  })

  it('joins Stop-before-save once and leaves a late save for B unable to snapshot B', async () => {
    const backfill = vi.fn(async () => ({ ok: true, named: 0 }))
    const id = realSpeakerId()
    const api = sessionApi({ id, backfill })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 700 })
    api.acceptLiveSpeakerTransition({ on: false, startedAt: 700 })
    expect(backfill).not.toHaveBeenCalled()

    api.acceptLiveSpeakerTransition({ on: true, startedAt: 800 })
    expect(api.recordLiveSpeakerSave(700, '/meetings/a.md')).toBe(true)
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1))
    expect(api.captureLiveSpeakerKey(800)).toBe('live:800')
    await expect(api.labelThemAudio(windowFor(4), 'live:800', 'live'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
  })

  it('lazily expires only closed unsaved receipts after 30 minutes and frees exact capacity', async () => {
    let now = 1_000
    const id = realSpeakerId()
    const api = sessionApi({ id, now: () => now })
    for (const startedAt of [100, 200, 300, 400]) {
      expect(api.acceptLiveSpeakerTransition({ on: true, startedAt })).toBe(true)
    }
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 500 })).toBe(true)
    expect(api.captureLiveSpeakerKey(500)).toBeNull()

    now += 30 * 60_000 + 1
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 600 })).toBe(true)
    expect(api.captureLiveSpeakerKey(600)).toBe('live:600')
    await expect(id.labelSessionWindow('live:100', windowFor(0), 'live')).resolves.toBeNull()
  })

  it('renderer crash discards the exact live state without snapshotting or flushing operator audio', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 900 })
    for (let i = 0; i < 3; i++) await api.observeOperatorAudio(windowFor(5), 'live:900')

    const gone = actualRendererGoneHandler({
      mainLog: { error: vi.fn() },
      auditLog: vi.fn(),
      resetDustConversation: vi.fn(),
      listeningActive: true,
      lastPlainAskAt: 1,
      audioArmed: true,
      setTrayRecording: vi.fn(),
      setRecordingPowerSaveBlock: vi.fn(),
      discardActiveLiveSpeakerSession: api.discardActiveLiveSpeakerSession,
      isMinimized: true,
      onboardingExclusiveLive: () => false,
      currentWidth: 1,
      BAR_WIDTH: 600,
      win: null,
      process: { env: {} },
      join
    })
    gone({}, { reason: 'crashed', exitCode: 1 })

    expect(api.captureLiveSpeakerKey(900)).toBeNull()
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 901 })
    await expect(api.labelThemAudio(windowFor(5), 'live:901', 'live'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
  })

  it('deletes a joined receipt before a snapshot failure and disposes the exact state', async () => {
    const backfill = vi.fn(async () => ({ ok: true, named: 0 }))
    let api!: SessionApi
    const fake = {
      createSession: vi.fn(() => true),
      snapshotSession: vi.fn(() => {
        expect(api.recordLiveSpeakerSave(1400, '/meetings/duplicate.md')).toBe(false)
        throw new Error('snapshot failed')
      }),
      disposeSession: vi.fn(() => true),
      discardSession: vi.fn()
    } as unknown as SpeakerId
    api = sessionApi({ id: fake, backfill })

    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 1400 })).toBe(true)
    expect(api.recordLiveSpeakerSave(1400, '/meetings/original.md')).toBe(true)
    expect(api.acceptLiveSpeakerTransition({ on: false, startedAt: 1400 })).toBe(true)
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1))
    expect(fake.disposeSession).toHaveBeenCalledExactlyOnceWith('live:1400')
    expect(backfill).toHaveBeenCalledWith('/meetings/original.md', undefined)
  })
})

function makeSnapshot(id: SpeakerId, key: string, axis: number): Promise<SpeakerEnrollmentSnapshot> {
  return (async () => {
    expect(id.createSession(key)).toBe(true)
    for (let i = 0; i < 3; i++) await id.labelSessionWindow(key, windowFor(axis), 'live')
    const snapshot = id.snapshotSession(key)
    expect(snapshot).not.toBeNull()
    return snapshot!
  })()
}

function backfillWith(id: SpeakerId, overrides: Record<string, unknown> = {}) {
  const original = [{ t: 1_000, text: 'hello', name: 'Speaker 1', speaker: 'them' }]
  const renamed = [{ ...original[0], name: 'Alice' }]
  return actualFunction('backfillSpeakerNames', {
    requireAuth: () => true,
    getSettings: () => ({ speakerId: { enabled: true } }),
    safeMeetingBasename: (file: string) => file,
    recallRead: async () => ({ ok: true, lines: original, startedAt: 1_000 }),
    fetchTeamsTranscriptForMeeting: async () => ({ entries: [] }),
    authStatus: () => ({ name: 'Operator' }),
    applySpeakerNames: () => ({ lines: renamed, named: 1 }),
    clusterNamePairsFromAlignment: () => [{ clusterLabel: 'Speaker 1', name: 'Alice' }],
    speakerIdProcessingEnabled: () => true,
    getSpeakerId: () => id,
    speakerIdInstance: id,
    auditLog: vi.fn(),
    updateMeetingTranscript: async () => ({ ok: true }),
    enqueueIngest: async () => undefined,
    resolveMeetingsFolder: () => '/meetings',
    join,
    mainLog: { warn: vi.fn() },
    ...overrides
  })
}

describe('snapshot-only enrollment after durable name write', () => {
  it('enrolls the exact token only after transcript update succeeds', async () => {
    const id = realSpeakerId()
    const token = await makeSnapshot(id, 'live:1000', 2)
    const order: string[] = []
    const wrapped = {
      ...id,
      enrollFromSnapshot: (snapshot: SpeakerEnrollmentSnapshot, pairs: readonly any[]) => {
        order.push(pairs.length ? 'enroll' : 'consume')
        return id.enrollFromSnapshot(snapshot, pairs)
      }
    } as SpeakerId
    const backfill = backfillWith(wrapped, {
      speakerIdInstance: wrapped,
      getSpeakerId: () => wrapped,
      updateMeetingTranscript: async () => { order.push('write'); return { ok: true } }
    })

    await expect(backfill('meeting.md', token)).resolves.toEqual({ ok: true, named: 1 })
    expect(order.slice(0, 2)).toEqual(['write', 'enroll'])
    expect(id.listProfiles()).toEqual([{ name: 'Alice', samples: 3 }])
  })

  it('failed transcript update enrolls zero and consumes the token', async () => {
    const id = realSpeakerId()
    const token = await makeSnapshot(id, 'live:1100', 2)
    const backfill = backfillWith(id, {
      updateMeetingTranscript: async () => ({ ok: false, error: 'write failed' })
    })

    await expect(backfill('meeting.md', token)).resolves.toEqual({ ok: false, error: 'write failed' })
    expect(id.listProfiles()).toEqual([])
    expect(id.enrollFromSnapshot(token, [{ clusterLabel: 'Speaker 1', name: 'Late' }])).toBe(0)
  })

  it('early auth rejection consumes the token and a manual no-token backfill never enrolls legacy buffers', async () => {
    const id = realSpeakerId()
    const token = await makeSnapshot(id, 'live:1200', 2)
    const rejected = backfillWith(id, { requireAuth: () => false })
    await expect(rejected('meeting.md', token)).resolves.toMatchObject({ ok: false })
    expect(id.enrollFromSnapshot(token, [{ clusterLabel: 'Speaker 1', name: 'Late' }])).toBe(0)

    for (let i = 0; i < 3; i++) await id.labelWindow(windowFor(3), 'live')
    await expect(backfillWith(id)('meeting.md')).resolves.toEqual({ ok: true, named: 1 })
    expect(id.listProfiles()).toEqual([])
  })
})

describe('exact import attempt integration', () => {
  it('passes the frozen attempt through the actual ImportJobManager dependency wiring', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    let captured: Record<string, any> | undefined
    const noop = () => undefined
    actualFunction('initializeImportJobs', {
      importJobs: null,
      wireIntelligenceIndexWork: noop,
      ImportJobManager: class { constructor(deps: Record<string, any>) { captured = deps } },
      EncryptedImportJobStore: class {},
      getSettings: () => ({ asrLanguage: 'auto', asrEngine: 'parakeet', mode: 'meeting' }),
      resetImportLanguageFollow: noop,
      startImportDecoder: noop,
      parakeetTranscribe: noop,
      whisperImportTranscribe: noop,
      detectImportLanguage: noop,
      ensureParakeetModel: noop,
      beginImportSpeakers: api.beginImportSpeakers,
      captureImportSpeakerKey: api.captureImportSpeakerKey,
      labelThemAudio: api.labelThemAudio,
      finalizeImportSpeakers: api.finalizeImportSpeakers,
      disposeImportSpeakers: api.disposeImportSpeakers,
      resetImportDecoder: noop,
      deleteMeeting: noop,
      enqueueIngest: noop,
      recordMeetingSummarized: noop,
      publishImportJob: noop,
      closeImportDecoder: noop,
      stopWhisperHost: noop,
      listeningActive: false,
      parakeetRelease: noop,
      releaseSpeakerEmbedding: noop,
      runIntelligenceIndex: noop,
      MAX_CONCURRENT_DECODES: 1,
      ensureImportAsrAssets: () => Promise.resolve(),
      runImportedRecap: noop,
      mainLog: { warn: noop, error: noop }
    })()
    expect(captured).toBeDefined()

    const attempt = Object.freeze({ jobId: 'wired-job', attemptId: 7 })
    expect(captured!.beginSpeakers(attempt)).toBe(true)
    await expect(captured!.speakerFor(windowFor(1), attempt)).resolves.toBe('Speaker 1')
    expect(captured!.finalizeSpeakers(attempt)).toEqual(new Map([['Speaker 1', 'Speaker 1']]))
    captured!.disposeSpeakers(attempt)
    expect(api.captureImportSpeakerKey(attempt)).toBeNull()
  })

  it('keeps live and import labels isolated and rejects stale same-job cleanup', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    const attempt1 = Object.freeze({ jobId: 'job-a', attemptId: 1 })
    const attempt2 = Object.freeze({ jobId: 'job-a', attemptId: 2 })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 1300 })
    expect(api.beginImportSpeakers(attempt1)).toBe(true)
    await expect(api.labelThemAudio(windowFor(0), 'live:1300', 'live'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
    await expect(api.labelThemAudio(windowFor(1), api.captureImportSpeakerKey(attempt1), 'import'))
      .resolves.toMatchObject({ name: 'Speaker 1' })

    api.disposeImportSpeakers(attempt1)
    expect(api.beginImportSpeakers(attempt2)).toBe(true)
    // Manager cleanup is exact-once, but a duplicated late callback must still be harmless.
    api.disposeImportSpeakers(attempt1)
    await expect(api.labelThemAudio(windowFor(2), api.captureImportSpeakerKey(attempt2), 'import'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
    expect(api.finalizeImportSpeakers(attempt1)).toBeNull()
    expect(api.finalizeImportSpeakers(attempt2)).toEqual(new Map([['Speaker 1', 'Speaker 1']]))
  })

  it('privacy revocation makes re-enable unable to replay an old import attempt', async () => {
    let enabled = true
    const id = realSpeakerId()
    const api = sessionApi({ id, enabled: () => enabled })
    const attempt = Object.freeze({ jobId: 'job-b', attemptId: 1 })
    expect(api.beginImportSpeakers(attempt)).toBe(true)
    enabled = false
    api.applySpeakerIdPolicy(false)
    enabled = true
    expect(api.captureImportSpeakerKey(attempt)).toBeNull()
    expect(api.finalizeImportSpeakers(attempt)).toBeNull()
    api.disposeImportSpeakers(attempt)
  })
})
