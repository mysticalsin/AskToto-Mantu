import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
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

import { LiveMeetingStartedAtSchema, SaveMeetingSchema } from '@shared/ipc'
import { redactSecrets } from '@shared/redact'
import { InputSessionAuthority } from './input-session-authority'
import { MeetingMicCaptureAuthority } from './meeting-mic-capture-authority'
import {
  MEETING_START_ACTION,
  MeetingStartActivationAuthority,
  type MeetingStartActivationFrame
} from './meeting-start-activation-authority'
import { InputSessionLifecycleController } from './lifecycle/input-session-lifecycle-controller'
import { TranscriptSaveReceiptStore } from './transcript-save-receipts'
import { createListeningStateHandler } from './listening-state-ipc'
import { createSpeakerId, type SpeakerEnrollmentSnapshot, type SpeakerId } from './speaker-id'
import { crashDetail } from './infra/observability/crash-taxonomy'
import { createImportMeetingWriteAdapters } from './import-meeting-write-adapters'
import { readModuleSource } from '../test-helpers/module-source'

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

function runSourceContext(sourceText: string, globals: Record<string, unknown>): vm.Context {
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
  return context
}

// activationFrameFromEvent moved out of index.ts with the G28 conversation wiring.
const conversationWiringSource = ts.createSourceFile(
  'conversation-wiring',
  readModuleSource(__dirname, './lifecycle/conversation-wiring').text,
  ts.ScriptTarget.Latest,
  true
)

function actualFunctionSource(name: string): string {
  const isNamed = (node: ts.Node): boolean => ts.isFunctionDeclaration(node) && node.name?.text === name
  const fromWiring = conversationWiringSource.statements.find(isNamed)
  const declaration = fromWiring ?? indexSource.statements.find(isNamed)
  expect(declaration, 'Actual source function ' + name + ' was not found').toBeDefined()
  if (!declaration) return ''
  const owner = fromWiring ? conversationWiringSource : indexSource
  return declaration.getText(owner).replace(/^export\s+/, '')
}

function actualFunction(name: string, globals: Record<string, unknown>): (...args: any[]) => any {
  const declaration = indexSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)
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
    )
      callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  expect(callback, `Actual IPC.${channel} handler was not found`).toBeDefined()
  if (!callback) return () => undefined
  return runSource(`globalThis.result = (${callback.getText(indexSource)});`, globals)
}

function actualRendererGoneHarness(globals: Record<string, unknown>): {
  handler: (...args: any[]) => any
  setCurrentWindow: (currentWindow: unknown) => void
} {
  let callback: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(indexSource) === 'win.webContents' &&
      node.expression.name.text === 'on' &&
      node.arguments[0]?.getText(indexSource) === "'render-process-gone'"
    )
      callback = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(indexSource)
  expect(callback, 'Actual overlay render-process-gone handler was not found').toBeDefined()
  if (!callback) return { handler: () => undefined, setCurrentWindow: () => {} }
  // The handler's automatic-reload branch calls the real reloadOverlay(...) helper — lift it too, so a
  // reload exercises the shipped loadURL + redact + audit wiring instead of a hand-copied stand-in.
  const reloadOverlayDecl = indexSource.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'reloadOverlay'
  )
  expect(reloadOverlayDecl, 'Actual source function reloadOverlay was not found').toBeDefined()
  const prefix = reloadOverlayDecl ? `${reloadOverlayDecl.getText(indexSource)}\n` : ''
  const context = runSourceContext(`${prefix}globalThis.result = (${callback.getText(indexSource)});`, globals)
  return {
    handler: (context as any).result,
    setCurrentWindow: (currentWindow) => {
      ;(context as any).win = currentWindow
    }
  }
}

interface SessionApi {
  acceptLiveSpeakerTransition(change: { on: boolean; startedAt?: number }): boolean
  captureLiveSpeakerKey(startedAt: unknown): string | null
  recordLiveSpeakerSave(startedAt: number, file: string): boolean
  discardActiveLiveSpeakerSession(): void
  hardStopInputSession(reason: string): void
  hardStopMeetingCapture(reason: string, speakerDisposition?: 'close' | 'discard'): void
  labelThemAudio(samples: Float32Array, key: string | null, owner: 'live' | 'import'): Promise<any>
  observeOperatorAudio(samples: Float32Array, key: string | null): Promise<void>
  applySpeakerIdPolicy(enabled: boolean): boolean
  beginImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): boolean
  captureImportSpeakerKey(attempt: { readonly jobId: string; readonly attemptId: number }): string | null
  finalizeImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): Map<string, string> | null
  disposeImportSpeakers(attempt: { readonly jobId: string; readonly attemptId: number }): void
  activationFrameFromEvent(event: any): MeetingStartActivationFrame | null
  meetingStartActivationAuthority: MeetingStartActivationAuthority
  inputSessionAuthority: InputSessionAuthority
  releaseMeetingCalls(startedAt: number): number
  successfulMeetingReleases(): number
  getContextRevision(): number
  getSpeakerId(): SpeakerId
  hasMeetingReservation(): boolean
  meetingStartedAt(): number | null
  lifecycle: Record<string, any>
  win: any
}

function sessionApi(options: {
  id: SpeakerId
  enabled?: () => boolean
  now?: () => number
  onPackRefresh?: () => void
  backfill?: (file: string, snapshot?: SpeakerEnrollmentSnapshot) => Promise<unknown>
  powerHooksReady?: boolean
  authSessionGeneration?: number
  ownerSession?: { revokeAll(reason: string): void } | null
}): SessionApi {
  const start = indexText.indexOf('// --- Speaker session ownership (Task 7-P2b) ---')
  const end = indexText.indexOf('// --- End speaker session ownership ---')
  expect(start, 'Speaker session ownership region start was not found').toBeGreaterThanOrEqual(0)
  expect(end, 'Speaker session ownership region end was not found').toBeGreaterThan(start)
  if (start < 0 || end <= start) throw new Error('Speaker session ownership implementation is absent')
  const region = indexText.slice(start, end)
  const powerHooksReady = options.powerHooksReady ?? true
  const authSessionGeneration = options.authSessionGeneration ?? 7
  const frameUrl = 'file:///renderer/index.html'
  const lifecycle = {
    setListeningActive: vi.fn(),
    setTrayRecording: vi.fn(),
    setRecordingPowerSaveBlock: vi.fn(),
    parakeetRelease: vi.fn(async () => undefined),
    releaseSpeakerEmbedding: vi.fn(async () => undefined),
    revokeMeetingMicCaptureGrants: vi.fn(),
    rebuildTrayMenu: vi.fn(),
    refreshSpeechPack: options.onPackRefresh ?? vi.fn()
  }
  const win = {
    isDestroyed: () => false,
    loadURL: vi.fn(() => Promise.resolve()),
    webContents: { id: 1, send: vi.fn() }
  }
  const inputSessionAuthority = new InputSessionAuthority()
  const releaseMeetingSpy = vi.spyOn(inputSessionAuthority, 'releaseMeeting')
  let context: any
  const meetingStartActivationAuthority = new MeetingStartActivationAuthority({
    state: () => ({
      mainWebContentsId: 1,
      mainFrameId: '11:22',
      isWindowVisible: true,
      isAuthenticated: true,
      isStartAllowed: powerHooksReady,
      currentUrl: frameUrl,
      context: {
        authSessionGeneration,
        contextRevision: context?.result?.getContextRevision() ?? 0
      }
    }),
    now: options.now
  })
  const meetingMicCaptureAuthority = new MeetingMicCaptureAuthority({
    currentState: () => {
      const currentWindow = context ? (context as any).win : win
      return {
        mainWebContentsId: currentWindow && !currentWindow.isDestroyed() ? currentWindow.webContents.id : null,
        isWindowVisible: true,
        isAuthenticated: true,
        currentUrl: frameUrl,
        context: {
          authSessionGeneration,
          contextRevision: context?.result?.getContextRevision() ?? 0
        },
        meetingStartedAt: inputSessionAuthority.hasMeetingReservation ? inputSessionAuthority.meetingStartedAt : null
      }
    },
    createCaptureId: randomUUID,
    onRevoked: () => {}
  })
  const revokeMeeting = meetingMicCaptureAuthority.revokeMeeting.bind(meetingMicCaptureAuthority)
  vi.spyOn(meetingMicCaptureAuthority, 'revokeMeeting').mockImplementation((startedAt, reason) => {
    lifecycle.revokeMeetingMicCaptureGrants(startedAt, reason)
    revokeMeeting(startedAt, reason)
  })
  const exports = [
    'acceptLiveSpeakerTransition,',
    'captureLiveSpeakerKey,',
    'recordLiveSpeakerSave,',
    'discardActiveLiveSpeakerSession,',
    'hardStopInputSession,',
    'hardStopMeetingCapture,',
    'labelThemAudio,',
    'observeOperatorAudio,',
    'applySpeakerIdPolicy,',
    'beginImportSpeakers,',
    'captureImportSpeakerKey,',
    'finalizeImportSpeakers,',
    'disposeImportSpeakers,',
    'activationFrameFromEvent,',
    'getSpeakerId,',
    'getContextRevision: () => inputSessionContextRevision,',
    'hasMeetingReservation: () => inputSessionAuthority.hasMeetingReservation,',
    'meetingStartedAt: () => inputSessionAuthority.meetingStartedAt'
  ].join('\n')
  const source = [
    'let inputSessionContextRevision = 0;',
    'let inputPowerLifecycleHooksReady = ' + String(powerHooksReady) + ';',
    'let meetingCaptureOwnerWebContentsId = null;',
    actualFunctionSource('activationFrameFromEvent'),
    actualFunctionSource('hardStopInputSession'),
    actualFunctionSource('hardStopMeetingCapture'),
    region,
    'const inputSessionLifecycleController = new InputSessionLifecycleController({',
    '  ownerSession: ownerSessionLifecycle,',
    '  inputSessionAuthority,',
    '  meetingStartActivationAuthority,',
    '  meetingMicCaptureAuthority,',
    "  meetingMicCaptureRevokedChannel: 'meeting:mic-capture-revoked',",
    '  incrementInputSessionContextRevision: () => { inputSessionContextRevision += 1; },',
    '  getWindow: () => win,',
    '  getMeetingCaptureOwnerWebContentsId: () => meetingCaptureOwnerWebContentsId,',
    '  setMeetingCaptureOwnerWebContentsId: (id) => { meetingCaptureOwnerWebContentsId = id; },',
    '  getActiveLiveSpeakerStartedAt: () => activeLiveSpeakerStartedAt,',
    '  setActiveLiveSpeakerStartedAt: (startedAt) => { activeLiveSpeakerStartedAt = startedAt; },',
    '  discardActiveLiveSpeakerSession,',
    '  closeLiveSpeakerReceipt,',
    '  setLegacyListeningActive,',
    '  setListeningActive,',
    '  setTrayRecording,',
    '  setRecordingPowerSaveBlock,',
    '  parakeetRelease,',
    "  releaseSpeakerEmbedding: () => releaseSpeakerEmbedding('live')",
    '});',
    'globalThis.result = {',
    exports,
    '};'
  ].join('\n')
  context = runSourceContext(source, {
    createSpeakerId: () => options.id,
    getSettings: () => ({ speakerId: { enabled: options.enabled?.() ?? true } }),
    LiveMeetingStartedAtSchema,
    Date: class extends Date {
      static now(): number {
        return options.now?.() ?? Date.now()
      }
    },
    backfillSpeakerNames: options.backfill ?? (async () => ({ ok: true, named: 0 })),
    mainLog: { warn: vi.fn(), error: vi.fn() },
    rebuildTrayMenu: lifecycle.rebuildTrayMenu,
    speechPackDesktop: { refresh: lifecycle.refreshSpeechPack },
    inputSessionAuthority,
    meetingStartActivationAuthority,
    meetingMicCaptureAuthority,
    InputSessionLifecycleController,
    ownerSessionLifecycle: { current: () => options.ownerSession ?? null },
    revokeMeetingMicCaptureGrants: lifecycle.revokeMeetingMicCaptureGrants,
    setListeningActive: lifecycle.setListeningActive,
    setTrayRecording: lifecycle.setTrayRecording,
    setRecordingPowerSaveBlock: lifecycle.setRecordingPowerSaveBlock,
    parakeetRelease: lifecycle.parakeetRelease,
    releaseSpeakerEmbedding: lifecycle.releaseSpeakerEmbedding,
    win,
    IPC: { meetingMicCaptureRevoked: 'meeting:mic-capture-revoked' }
  })
  return Object.assign((context as any).result, {
    meetingStartActivationAuthority,
    inputSessionAuthority,
    releaseMeetingCalls: (startedAt: number) =>
      releaseMeetingSpy.mock.calls.filter(([owner]) => owner === startedAt).length,
    successfulMeetingReleases: () => releaseMeetingSpy.mock.results.filter((result) => result.value === true).length,
    hasMeetingReservation: () => inputSessionAuthority.hasMeetingReservation,
    meetingStartedAt: () => inputSessionAuthority.meetingStartedAt,
    lifecycle,
    win
  })
}

function activationEvent(parent: unknown = null): any {
  return {
    sender: { id: 1 },
    senderFrame: { processId: 11, routingId: 22, parent, url: 'file:///renderer/index.html' }
  }
}

function mintMeetingStartActivation(api: SessionApi, event: any): boolean {
  const frame = api.activationFrameFromEvent(event)
  return !!frame && api.meetingStartActivationAuthority.mint(frame, MEETING_START_ACTION)
}

function actualListeningStateHandler(api: SessionApi): (...args: any[]) => Promise<any> {
  return actualIpcHandler('listeningState', {
    createListeningStateHandler,
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    acceptLiveSpeakerTransition: api.acceptLiveSpeakerTransition,
    activationFrameFromEvent: api.activationFrameFromEvent,
    meetingStartActivationAuthority: api.meetingStartActivationAuthority,
    MEETING_START_ACTION,
    setListeningActive: api.lifecycle.setListeningActive,
    setTrayRecording: api.lifecycle.setTrayRecording,
    setRecordingPowerSaveBlock: api.lifecycle.setRecordingPowerSaveBlock,
    parakeetRelease: api.lifecycle.parakeetRelease,
    releaseSpeakerEmbedding: api.lifecycle.releaseSpeakerEmbedding,
    resetDustConversation: vi.fn(),
    getSettings: () => ({ providerModels: {}, dustWorkspaceId: '', dustBaseUrl: '' }),
    getApiKey: () => '',
    prewarmDustConversation: vi.fn(),
    speakerIdProcessingEnabled: () => true,
    speakerIdInstance: api.getSpeakerId()
  })
}

function rendererGoneHarness(api: SessionApi): {
  revokeForLifecycleEvent: ReturnType<typeof vi.fn>
  hardStopMeetingCapture: ReturnType<typeof vi.spyOn>
  fire: () => void
  setCurrentWindow: (currentWindow: unknown) => void
} {
  const win = api.win
  const revokeForLifecycleEvent = vi.fn()
  const hardStopMeetingCapture = vi.spyOn(api, 'hardStopMeetingCapture')
  const gone = actualRendererGoneHarness({
    mainLog: { error: vi.fn() },
    auditLog: vi.fn(),
    crashDetail,
    resetDustConversation: vi.fn(),
    listeningActive: true,
    lastPlainAskAt: 1,
    audioArmed: true,
    setListeningActive: vi.fn(),
    setAudioArmed: vi.fn(),
    setTrayRecording: vi.fn(),
    setRecordingPowerSaveBlock: vi.fn(),
    hardStopInputSession: api.hardStopInputSession,
    hardStopMeetingCapture: api.hardStopMeetingCapture,
    discardActiveLiveSpeakerSession: api.discardActiveLiveSpeakerSession,
    invalidateCloudSttOwner: vi.fn(),
    isMinimized: true,
    onboardingExclusiveLive: () => false,
    currentWidth: 1,
    BAR_WIDTH: 600,
    win,
    self: win,
    selfOwner: { window: win, webContents: win.webContents, webContentsId: win.webContents.id },
    commandControl: { revokeForLifecycleEvent },
    responsiveness: { markGone: vi.fn() },
    reloadBudget: { onRenderProcessGone: () => 'reload' },
    overlayRendererUrl: () => 'file:///renderer/index.html',
    redactSecrets,
    process: { env: {} },
    join
  })
  return {
    revokeForLifecycleEvent,
    hardStopMeetingCapture,
    fire: () => gone.handler({}, { reason: 'crashed', exitCode: 1 }),
    setCurrentWindow: gone.setCurrentWindow
  }
}

function triggerRendererGone(api: SessionApi) {
  const harness = rendererGoneHarness(api)
  harness.fire()
  return harness
}

function expectCrashCaptureTeardown(api: SessionApi, startedAt: number): void {
  expect(api.lifecycle.revokeMeetingMicCaptureGrants).toHaveBeenCalledExactlyOnceWith(startedAt, 'owner-replaced')
  expect(api.releaseMeetingCalls(startedAt)).toBe(1)
  expect(api.successfulMeetingReleases()).toBe(1)
  expect(api.hasMeetingReservation()).toBe(false)
  expect(api.meetingStartedAt()).toBeNull()
  expect(api.lifecycle.parakeetRelease).toHaveBeenCalledTimes(1)
  expect(api.lifecycle.releaseSpeakerEmbedding).toHaveBeenCalledExactlyOnceWith('live')
  expect(api.lifecycle.setListeningActive).toHaveBeenCalledWith(false)
  expect(api.lifecycle.setTrayRecording).toHaveBeenCalledWith(false)
  expect(api.lifecycle.setRecordingPowerSaveBlock).toHaveBeenCalledWith(false)
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speaker-session-wiring-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function realSpeakerId(
  compute: (samples: Float32Array) => Promise<Float32Array | null> = async (samples) =>
    samples.length ? embeddingFor(Math.round(samples[0])) : null
): SpeakerId {
  return createSpeakerId({
    createExtractor: () => ({ compute }),
    storePath: () => join(dir, 'voiceprints.json'),
    canSaveVoiceprints: () => true
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

function saveHandler(
  api: SessionApi,
  file = '/meetings/meeting-a.md',
  options: {
    saveMeeting?: (settings?: unknown, meeting?: unknown) => Promise<string>
    clearDraftTranscript?: (settings: unknown, startedAt: number, savedTranscriptPath?: string) => Promise<void>
    getSettings?: () => unknown
    recordMeetingSummarized?: (...args: any[]) => void
    scheduleRebuild?: (...args: any[]) => unknown
    enqueueIngest?: (...args: any[]) => unknown
    backfillSpeakerNames?: (file: string) => Promise<unknown>
    receipts?: TranscriptSaveReceiptStore
  } = {}
): (...args: any[]) => Promise<any> {
  const transcriptSaveReceipts = options.receipts ?? new TranscriptSaveReceiptStore()
  const scheduleRebuild = options.scheduleRebuild ?? vi.fn()
  const enqueueIngest = options.enqueueIngest ?? vi.fn()
  const handler = actualIpcHandler('saveTranscript', {
    assertMainWindow: vi.fn(),
    requireAuth: () => true,
    takeHotPath: () => true,
    SaveMeetingSchema,
    LiveMeetingStartedAtSchema,
    createHash,
    authSessionGeneration: () => 7,
    transcriptSaveReceipts,
    stripProvisionalLines: (lines: unknown) => lines,
    // The handler's one write step (create, or rewrite the meeting's existing file) is exercised in
    // save-identity.relaunch.test.ts; here it is the injected save so these tests keep asserting stage order.
    writeMeetingOnce: (_receipt: unknown, settings: unknown, meeting: unknown) =>
      (options.saveMeeting ?? (async () => file))(settings, meeting),
    getSettings: options.getSettings ?? (() => ({ brainConsolidation: { enabled: false }, encryptTranscripts: false })),
    recordMeetingSummarized: options.recordMeetingSummarized ?? vi.fn(),
    meetingDurationMin: () => 1,
    wordsFromTexts: () => [],
    estimateNoteTakingMinutes: () => 0,
    appendTimeSavedEvent: vi.fn(),
    clearDraftTranscript: options.clearDraftTranscript ?? (async () => undefined),
    auditLog: vi.fn(),
    scheduleRebuild: (assertAdmission: () => void, settled: () => void) => {
      scheduleRebuild(assertAdmission, settled)
      settled()
    },
    enqueueIngest: async (_path: string, _options: unknown, _assertAdmission: () => void, settled: () => void) => {
      await enqueueIngest(_path, _options, _assertAdmission, settled)
      settled()
    },
    recordLiveSpeakerSave: api.recordLiveSpeakerSave,
    backfillSpeakerNames: options.backfillSpeakerNames ?? vi.fn(async () => ({ ok: true, named: 0 })),
    warnSpeakerFailure: vi.fn()
  })
  return handler
}

describe('authoritative live speaker identity', () => {
  it('wires the listening registration to the single transition and activation authorities', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const event = activationEvent()
    const handler = actualListeningStateHandler(api)

    expect(mintMeetingStartActivation(api, event)).toBe(true)
    await expect(handler(event, { on: true, startedAt: 100 })).resolves.toBe(true)
    expect(mintMeetingStartActivation(api, event)).toBe(true)
    await expect(handler(event, { on: true, startedAt: 200 })).resolves.toBe(true)
    await expect(handler(event, { on: false, startedAt: 100 })).resolves.toBe(false)
    expect(api.lifecycle.setTrayRecording.mock.calls.map((call: any[]) => call[0])).toEqual([true, false, true])
    expect(api.lifecycle.setRecordingPowerSaveBlock.mock.calls.map((call: any[]) => call[0])).toEqual([
      true,
      false,
      true
    ])
    expect(api.lifecycle.parakeetRelease).toHaveBeenCalledTimes(1)
    expect(api.lifecycle.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)

    await expect(handler(event, { on: false, startedAt: 200 })).resolves.toBe(true)
    expect(api.lifecycle.setTrayRecording.mock.calls.map((call: any[]) => call[0])).toEqual([true, false, true, false])
    expect(api.lifecycle.setRecordingPowerSaveBlock.mock.calls.map((call: any[]) => call[0])).toEqual([
      true,
      false,
      true,
      false
    ])
    expect(api.lifecycle.parakeetRelease).toHaveBeenCalledTimes(2)
    expect(api.lifecycle.releaseSpeakerEmbedding).toHaveBeenCalledTimes(2)
  })

  it('rejects unminted and replayed starts before tray, power, or native effects', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const event = activationEvent()
    const handler = actualListeningStateHandler(api)

    await expect(handler(event, { on: true, startedAt: 101 })).resolves.toBe(false)
    expect(api.hasMeetingReservation()).toBe(false)
    expect(api.lifecycle.setTrayRecording).not.toHaveBeenCalled()
    expect(api.lifecycle.setRecordingPowerSaveBlock).not.toHaveBeenCalled()
    expect(api.lifecycle.parakeetRelease).not.toHaveBeenCalled()
    expect(api.lifecycle.releaseSpeakerEmbedding).not.toHaveBeenCalled()

    expect(mintMeetingStartActivation(api, event)).toBe(true)
    await expect(handler(event, { on: true, startedAt: 101 })).resolves.toBe(true)
    await expect(handler(event, { on: true, startedAt: 102 })).resolves.toBe(false)
    expect(api.hasMeetingReservation()).toBe(true)
    expect(api.meetingStartedAt()).toBe(101)
    expect(api.lifecycle.setTrayRecording.mock.calls.map((call: any[]) => call[0])).toEqual([true])
    expect(api.lifecycle.setRecordingPowerSaveBlock.mock.calls.map((call: any[]) => call[0])).toEqual([true])
    expect(api.lifecycle.parakeetRelease).not.toHaveBeenCalled()
    expect(api.lifecycle.releaseSpeakerEmbedding).not.toHaveBeenCalled()
  })

  it('fails closed when lifecycle power hooks are unavailable', async () => {
    const api = sessionApi({ id: realSpeakerId(), powerHooksReady: false })
    const event = activationEvent()
    const handler = actualListeningStateHandler(api)

    expect(mintMeetingStartActivation(api, event)).toBe(false)
    await expect(handler(event, { on: true, startedAt: 103 })).resolves.toBe(false)
    expect(api.hasMeetingReservation()).toBe(false)
    expect(api.lifecycle.setTrayRecording).not.toHaveBeenCalled()
    expect(api.lifecycle.setRecordingPowerSaveBlock).not.toHaveBeenCalled()
    expect(api.lifecycle.parakeetRelease).not.toHaveBeenCalled()
    expect(api.lifecycle.releaseSpeakerEmbedding).not.toHaveBeenCalled()
  })

  it('transition-only handler rejects a delayed older start and stale stop while the newer owner stays active', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    const setListeningActive = vi.fn()
    const releaseParakeet = vi.fn(async () => undefined)
    const releaseSpeakerEmbedding = vi.fn(async () => undefined)
    const handler = createListeningStateHandler({
      assertMainWindow: vi.fn(),
      requireAuth: () => true,
      acceptTransition: api.acceptLiveSpeakerTransition,
      consumeMeetingStartActivation: () => true,
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
    const refresh = vi.fn()
    const api = sessionApi({ id: realSpeakerId(), onPackRefresh: refresh })
    expect(api.acceptLiveSpeakerTransition({ on: true })).toBe(true)
    expect(api.captureLiveSpeakerKey(undefined)).toBeNull()
    expect(api.acceptLiveSpeakerTransition({ on: false })).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 300 })).toBe(true)
    expect(api.acceptLiveSpeakerTransition({ on: false })).toBe(false)
    expect(api.acceptLiveSpeakerTransition({ on: true })).toBe(false)
    expect(api.captureLiveSpeakerKey(300)).toBe('live:300')
    expect(refresh).toHaveBeenCalledTimes(2)
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
  it.each([
    'parakeetFeed',
    'appleSpeechFeed'
  ] as const)('%s captures A before ASR await so delayed A work cannot seed B', async (channel) => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 100 })
    let resolveA!: (text: string) => void
    const transcribe = vi.fn((samples: Float32Array) =>
      samples[0] === 0
        ? new Promise<string>((resolve) => {
            resolveA = resolve
          })
        : Promise.resolve('meeting B')
    )
    const handler = feedHandler(channel, api, transcribe)

    const pendingA = handler({}, { samples: windowFor(0), speaker: 'them', startedAt: 100 })
    await Promise.resolve()
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
    resolveA('meeting A')

    await expect(pendingA).resolves.toMatchObject({ text: 'meeting A' })
    await expect(handler({}, { samples: windowFor(1), speaker: 'them', startedAt: 200 })).resolves.toEqual({
      text: 'meeting B',
      name: 'Speaker 1'
    })
  })

  it.each([
    'parakeetFeed',
    'appleSpeechFeed'
  ] as const)('%s preserves ASR text and performs no speaker work for stale, missing, or malformed identity', async (channel) => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
    const handler = feedHandler(channel, api)

    for (const startedAt of [100, undefined, 0, '200']) {
      await expect(handler({}, { samples: windowFor(0), speaker: 'them', startedAt })).resolves.toEqual({
        text: 'transcribed'
      })
    }
    await expect(handler({}, { samples: windowFor(1), speaker: 'them', startedAt: 200 })).resolves.toEqual({
      text: 'transcribed',
      name: 'Speaker 1'
    })
  })

  it('speakerEmbed preserves its empty shape and cannot observe or echo-drop without exact identity', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 200 })
    const handler = feedHandler('speakerEmbed', api)

    for (let i = 0; i < 3; i++) {
      await expect(handler({}, { samples: windowFor(2), speaker: 'you' })).resolves.toEqual({})
    }
    await expect(handler({}, { samples: windowFor(2), speaker: 'them', startedAt: 100 })).resolves.toEqual({})
    await expect(handler({}, { samples: windowFor(2), speaker: 'them', startedAt: 200 })).resolves.toEqual({
      name: 'Speaker 1'
    })
  })

  it.each([
    'false',
    'throw'
  ] as const)('speaker admission %s keeps ASR text and never falls back to legacy state', async (mode) => {
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
    await expect(handler({}, { samples: windowFor(0), speaker: 'them', startedAt: 500 })).resolves.toEqual({
      text: 'transcribed'
    })
    expect(fake.labelSessionWindow).not.toHaveBeenCalled()
    expect(fake.labelWindow).not.toHaveBeenCalled()
    expect(fake.resetSession).not.toHaveBeenCalled()
  })
})

describe('bounded close and successful-save receipt join', () => {
  it('awaits finalized draft cleanup after the final transcript is durable and before IPC success', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const file = '/meetings/finalized.md'
    let transcriptDurable = false
    let releaseCleanup!: () => void
    const cleanupWait = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const saveMeeting = vi.fn(async () => {
      transcriptDurable = true
      return file
    })
    const clearDraftTranscript = vi.fn(async () => {
      expect(transcriptDurable).toBe(true)
      await cleanupWait
    })
    const handler = saveHandler(api, file, { saveMeeting, clearDraftTranscript })
    const response = handler({}, { startedAt: 600, lines: [], recap: '', mode: 'meeting' })
    await vi.waitFor(() => expect(clearDraftTranscript).toHaveBeenCalledOnce())
    let acknowledged = false
    void response.then(() => {
      acknowledged = true
    })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    releaseCleanup()
    await expect(response).resolves.toEqual({ path: file })
  })

  it('cleans the saved transcript folder snapshot if settings change while the final save is pending', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const oldSettings = {
      brainConsolidation: { enabled: false },
      encryptTranscripts: false,
      meetingsFolder: '/old-meetings'
    }
    const newSettings = { ...oldSettings, meetingsFolder: '/new-meetings' }
    const savedPath = '/old-meetings/finalized.md'
    let settingsReads = 0
    const getSettings = vi.fn(() => (settingsReads++ === 0 ? oldSettings : newSettings))
    const saveMeeting = vi.fn(async () => savedPath)
    const clearDraftTranscript = vi.fn(async () => undefined)
    const handler = saveHandler(api, savedPath, { getSettings, saveMeeting, clearDraftTranscript })
    const meeting = { startedAt: 601, lines: [], recap: '', mode: 'meeting' }

    await expect(handler({}, meeting)).resolves.toEqual({ path: savedPath })
    await expect(handler({}, meeting)).resolves.toEqual({ path: savedPath })

    expect(getSettings).toHaveBeenCalledOnce()
    expect(saveMeeting).toHaveBeenCalledWith(oldSettings, expect.objectContaining({ startedAt: 601 }))
    expect(saveMeeting).toHaveBeenCalledOnce()
    expect(clearDraftTranscript).toHaveBeenCalledWith(oldSettings, 601, savedPath)
    expect(clearDraftTranscript).toHaveBeenCalledOnce()
    expect(meeting.startedAt).toBe(601)
  })

  it('replays a zero timestamp with the first normalized identity without mutating its payload', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const file = '/meetings/finalized.md'
    const saveMeeting = vi.fn(async () => file)
    const clearDraftTranscript = vi.fn(async () => undefined)
    const handler = saveHandler(api, file, { saveMeeting, clearDraftTranscript })
    const meeting = { startedAt: 0, lines: [], recap: '', mode: 'meeting' }
    const now = vi.spyOn(Date, 'now').mockReturnValue(702)

    try {
      await expect(handler({}, meeting)).resolves.toEqual({ path: file })
      await expect(handler({}, meeting)).resolves.toEqual({ path: file })
    } finally {
      now.mockRestore()
    }

    expect(meeting.startedAt).toBe(0)
    expect(saveMeeting).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ startedAt: 702 }))
    expect(saveMeeting).toHaveBeenCalledOnce()
    expect(clearDraftTranscript).toHaveBeenCalledWith(expect.anything(), 702, file)
    expect(clearDraftTranscript).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent and completed transcript saves through the actual receipt store', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 602 })).toBe(true)
    const file = '/meetings/concurrent.md'
    let resolveWrite!: (path: string) => void
    const writeWait = new Promise<string>((resolve) => {
      resolveWrite = resolve
    })
    const saveMeeting = vi.fn(() => writeWait)
    const recordMeetingSummarized = vi.fn()
    const clearDraftTranscript = vi.fn(async () => undefined)
    const scheduleRebuild = vi.fn()
    const enqueueIngest = vi.fn()
    const backfillSpeakerNames = vi.fn(async () => ({ ok: true, named: 0 }))
    const handler = saveHandler(api, file, {
      saveMeeting,
      recordMeetingSummarized,
      clearDraftTranscript,
      scheduleRebuild,
      enqueueIngest,
      backfillSpeakerNames
    })
    const meeting = { startedAt: 602, lines: [], recap: '', mode: 'meeting' }
    const first = handler({}, meeting)
    const concurrent = handler({}, meeting)
    await vi.waitFor(() => expect(saveMeeting).toHaveBeenCalledOnce())
    resolveWrite(file)
    await expect(Promise.all([first, concurrent])).resolves.toEqual([{ path: file }, { path: file }])
    await expect(handler({}, meeting)).resolves.toEqual({ path: file })

    expect(saveMeeting).toHaveBeenCalledOnce()
    expect(recordMeetingSummarized).toHaveBeenCalledOnce()
    expect(clearDraftTranscript).toHaveBeenCalledOnce()
    expect(scheduleRebuild).toHaveBeenCalledOnce()
    expect(enqueueIngest).toHaveBeenCalledOnce()
    expect(backfillSpeakerNames).not.toHaveBeenCalled()
    expect(meeting.startedAt).toBe(602)
  })

  it('the actual save handler journals its durable receipt stage by stage (WP03-S09)', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    const file = '/meetings/meeting-journal.md'
    const records = new Map<string, any>()
    const journal = {
      load: async () => ({ ok: true as const, records: [...records.values()] }),
      put: async (rec: any) => void records.set(rec.receiptId, structuredClone(rec)),
      remove: async (id: string) => void records.delete(id)
    }
    const receipts = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: (path) => ({ savedBasename: path.split('/').pop()!, folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => 'receipt-1'
    })
    let ingestFails = true
    const enqueueIngest = vi.fn(async () => {
      if (ingestFails) throw new Error('brain busy')
    })
    const handler = saveHandler(api, file, { receipts, enqueueIngest })
    const meeting = { startedAt: 603, lines: [], recap: '', mode: 'meeting' }
    await expect(handler({}, meeting)).rejects.toThrow('brain busy')
    await receipts.journalIdle()
    expect([...records.values()]).toEqual([
      expect.objectContaining({
        meetingStartedAt: 603,
        savedBasename: 'meeting-journal.md',
        completed: ['summary-credit', 'time-saved-credit', 'draft-cleanup', 'audit', 'rebuild'],
        deferredIngest: false,
        stages: expect.objectContaining({ savedWritten: true, draftsUnlinked: true, brainIngestQueued: false })
      })
    ])
    ingestFails = false
    await expect(handler({}, meeting)).resolves.toEqual({ path: file })
    await receipts.journalIdle()
    expect(records.size).toBe(0)
  })

  it('waits for durable journal writes before side effects and for removal before IPC success', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    let releaseWrite!: () => void
    let releaseRemoval!: () => void
    const writeGate = new Promise<void>((resolve) => (releaseWrite = resolve))
    const removalGate = new Promise<void>((resolve) => (releaseRemoval = resolve))
    const journal = {
      load: async () => ({ ok: true as const, records: [] }),
      put: vi.fn(async () => writeGate),
      remove: vi.fn(async () => removalGate)
    }
    const receipts = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => 'gated'
    })
    const credit = vi.fn()
    const handler = saveHandler(api, '/meetings/a.md', { receipts, recordMeetingSummarized: credit })
    let returned = false
    const result = handler({}, { startedAt: 604, lines: [], recap: '', mode: 'meeting' }).then((value) => {
      returned = true
      return value
    })
    await vi.waitFor(() => expect(journal.put).toHaveBeenCalled())
    expect(credit).not.toHaveBeenCalled()
    expect(returned).toBe(false)
    releaseWrite()
    await vi.waitFor(() => expect(journal.remove).toHaveBeenCalled())
    expect(credit).toHaveBeenCalledOnce()
    expect(returned).toBe(false)
    releaseRemoval()
    await expect(result).resolves.toEqual({ path: '/meetings/a.md' })
  })

  it('retries a failed completion receipt before advancing without repeating the credited effect', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    let failJournal = true
    const journal = {
      load: async () => ({ ok: true as const, records: [] }),
      put: vi.fn(async (rec: { completed: string[] }) => {
        if (failJournal && rec.completed.includes('summary-credit')) throw new Error('journal EIO')
      }),
      remove: vi.fn(async () => undefined)
    }
    const receipts = new TranscriptSaveReceiptStore(256, {
      journal,
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => 'retry'
    })
    const credit = vi.fn()
    const cleanup = vi.fn(async () => undefined)
    const handler = saveHandler(api, '/meetings/a.md', {
      receipts,
      recordMeetingSummarized: credit,
      clearDraftTranscript: cleanup
    })
    const meeting = { startedAt: 605, lines: [], recap: '', mode: 'meeting' }
    await expect(handler({}, meeting)).rejects.toThrow('journal EIO')
    expect(credit).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    await expect(handler({}, meeting)).rejects.toThrow('journal EIO')
    expect(credit).toHaveBeenCalledOnce()
    expect(cleanup).not.toHaveBeenCalled()
    failJournal = false
    await expect(handler({}, meeting)).resolves.toEqual({ path: '/meetings/a.md' })
    expect(credit).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('registers unmatched speaker backfill before persisting speaker completion', async () => {
    const api = sessionApi({ id: realSpeakerId() })
    let fail = true
    const receipts = new TranscriptSaveReceiptStore(256, {
      journal: {
        load: async () => ({ ok: true as const, records: [] }),
        put: async (rec) => {
          if (fail && rec.completed.includes('speaker-save')) throw new Error('speaker journal EIO')
        },
        remove: async () => undefined
      },
      locate: () => ({ savedBasename: 'a.md', folderIdSha256: 'f'.repeat(64), revision: 3 }),
      newId: () => 'speaker'
    })
    const backfill = vi.fn(async () => ({ ok: true, named: 0 }))
    const handler = saveHandler(api, '/meetings/a.md', { receipts, backfillSpeakerNames: backfill })
    const meeting = { startedAt: 606, lines: [], recap: '', mode: 'meeting' }
    await expect(handler({}, meeting)).rejects.toThrow('speaker journal EIO')
    expect(backfill).toHaveBeenCalledOnce()
    fail = false
    await expect(handler({}, meeting)).resolves.toEqual({ path: '/meetings/a.md' })
    expect(backfill).toHaveBeenCalledOnce()
  })

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
    const backfill = vi.fn(async (_file: string, _snapshot?: SpeakerEnrollmentSnapshot) => ({ ok: true, named: 0 }))
    const id = realSpeakerId()
    const api = sessionApi({ id, backfill })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 700 })
    api.acceptLiveSpeakerTransition({ on: false, startedAt: 700 })
    expect(backfill).not.toHaveBeenCalled()

    api.acceptLiveSpeakerTransition({ on: true, startedAt: 800 })
    expect(api.recordLiveSpeakerSave(700, '/meetings/a.md')).toBe(true)
    await vi.waitFor(() => expect(backfill).toHaveBeenCalledTimes(1))
    expect(api.captureLiveSpeakerKey(800)).toBe('live:800')
    await expect(api.labelThemAudio(windowFor(4), 'live:800', 'live')).resolves.toMatchObject({ name: 'Speaker 1' })
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
    const backfill = vi.fn(async () => ({ ok: true, named: 0 }))
    const snapshotSession = vi.spyOn(id, 'snapshotSession')
    const api = sessionApi({ id, backfill })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 900 })
    for (let i = 0; i < 3; i++) await api.observeOperatorAudio(windowFor(5), 'live:900')

    const { revokeForLifecycleEvent, hardStopMeetingCapture } = triggerRendererGone(api)

    expect(revokeForLifecycleEvent).toHaveBeenCalledExactlyOnceWith('renderer_replaced')
    expect(hardStopMeetingCapture.mock.calls).toEqual([['owner-replaced', 'discard']])
    expectCrashCaptureTeardown(api, 900)
    expect(api.win.webContents.send).toHaveBeenCalledExactlyOnceWith('meeting:mic-capture-revoked', {
      startedAt: 900,
      reason: 'owner-replaced'
    })
    expect(api.win.loadURL).toHaveBeenCalledExactlyOnceWith('file:///renderer/index.html')

    expect(api.captureLiveSpeakerKey(900)).toBeNull()
    const lateSaveEvidence = {
      accepted: api.recordLiveSpeakerSave(900, '/meetings/late-after-crash.md'),
      snapshots: snapshotSession.mock.calls.length,
      backfills: backfill.mock.calls.length
    }
    expect(lateSaveEvidence).toEqual({ accepted: false, snapshots: 0, backfills: 0 })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 901 })
    await expect(api.labelThemAudio(windowFor(5), 'live:901', 'live')).resolves.toMatchObject({ name: 'Speaker 1' })
  })

  it('renderer crash discards a durable receipt without snapshotting or backfilling it', async () => {
    const id = realSpeakerId()
    const snapshotSession = vi.spyOn(id, 'snapshotSession')
    const disposeSession = vi.spyOn(id, 'disposeSession')
    const backfill = vi.fn(async (_file: string, _snapshot?: SpeakerEnrollmentSnapshot) => ({ ok: true, named: 0 }))
    const api = sessionApi({ id, backfill })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 902 })).toBe(true)
    for (let i = 0; i < 3; i++) await api.observeOperatorAudio(windowFor(5), 'live:902')
    const save = saveHandler(api, '/meetings/saved-before-crash.md')
    await expect(save({}, { startedAt: 902, lines: [], recap: '', mode: 'meeting' })).resolves.toEqual({
      path: '/meetings/saved-before-crash.md'
    })
    expect(backfill).not.toHaveBeenCalled()

    const { hardStopMeetingCapture } = triggerRendererGone(api)
    expect(hardStopMeetingCapture.mock.calls).toEqual([['owner-replaced', 'discard']])
    expectCrashCaptureTeardown(api, 902)
    const crashSaveEvidence = {
      snapshots: snapshotSession.mock.calls.length,
      backfills: backfill.mock.calls.map(([file]) => file),
      disposals: disposeSession.mock.calls.map(([key]) => key)
    }
    expect(crashSaveEvidence).toEqual({
      snapshots: 0,
      backfills: [],
      disposals: ['live:902']
    })
  })

  it('renderer crash still releases capture when speaker processing is disabled', () => {
    const id = realSpeakerId()
    const disposeSession = vi.spyOn(id, 'disposeSession')
    const api = sessionApi({ id, enabled: () => false })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 903 })).toBe(true)

    const { hardStopMeetingCapture } = triggerRendererGone(api)

    expect(hardStopMeetingCapture.mock.calls).toEqual([['owner-replaced', 'discard']])
    expectCrashCaptureTeardown(api, 903)
    expect(api.captureLiveSpeakerKey(903)).toBeNull()
    expect(disposeSession).not.toHaveBeenCalled()
  })

  it('renderer crash still releases capture when speaker receipt admission failed', () => {
    const id = realSpeakerId()
    const createSession = vi.spyOn(id, 'createSession').mockReturnValue(false)
    const disposeSession = vi.spyOn(id, 'disposeSession')
    const api = sessionApi({ id })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 904 })).toBe(true)
    expect(createSession).toHaveBeenCalledExactlyOnceWith('live:904')

    const { hardStopMeetingCapture } = triggerRendererGone(api)

    expect(hardStopMeetingCapture.mock.calls).toEqual([['owner-replaced', 'discard']])
    expectCrashCaptureTeardown(api, 904)
    expect(api.captureLiveSpeakerKey(904)).toBeNull()
    expect(disposeSession).not.toHaveBeenCalled()
  })

  it('repeated renderer crash cleanup does not release native state or dispose a speaker receipt twice', () => {
    const id = realSpeakerId()
    const disposeSession = vi.spyOn(id, 'disposeSession')
    const api = sessionApi({ id })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 905 })).toBe(true)

    const firstCrash = triggerRendererGone(api)
    triggerRendererGone(api)

    expect(firstCrash.hardStopMeetingCapture.mock.calls).toEqual([
      ['owner-replaced', 'discard'],
      ['owner-replaced', 'discard']
    ])
    expectCrashCaptureTeardown(api, 905)
    expect(disposeSession).toHaveBeenCalledExactlyOnceWith('live:905')
  })

  it('a retired window crash leaves the successor meeting and capture untouched', () => {
    const id = realSpeakerId()
    const disposeSession = vi.spyOn(id, 'disposeSession')
    const api = sessionApi({ id })
    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 906 })).toBe(true)
    const retiredCrash = rendererGoneHarness(api)

    expect(api.acceptLiveSpeakerTransition({ on: true, startedAt: 907 })).toBe(true)
    const successor = { isDestroyed: () => false, webContents: { id: 2 } }
    const teardownBeforeDelayedCrash = {
      grants: api.lifecycle.revokeMeetingMicCaptureGrants.mock.calls.length,
      native: api.lifecycle.parakeetRelease.mock.calls.length,
      embedding: api.lifecycle.releaseSpeakerEmbedding.mock.calls.length,
      releases: api.successfulMeetingReleases()
    }

    retiredCrash.setCurrentWindow(successor)
    retiredCrash.fire()

    expect(api.captureLiveSpeakerKey(907)).toBe('live:907')
    expect(api.meetingStartedAt()).toBe(907)
    expect(api.hasMeetingReservation()).toBe(true)
    expect(api.lifecycle.revokeMeetingMicCaptureGrants).toHaveBeenCalledTimes(teardownBeforeDelayedCrash.grants)
    expect(api.lifecycle.parakeetRelease).toHaveBeenCalledTimes(teardownBeforeDelayedCrash.native)
    expect(api.lifecycle.releaseSpeakerEmbedding).toHaveBeenCalledTimes(teardownBeforeDelayedCrash.embedding)
    expect(api.successfulMeetingReleases()).toBe(teardownBeforeDelayedCrash.releases)
    expect(disposeSession).not.toHaveBeenCalled()
    expect(retiredCrash.revokeForLifecycleEvent).not.toHaveBeenCalled()
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
    warnSpeakerFailure: vi.fn(),
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
      updateMeetingTranscript: async () => {
        order.push('write')
        return { ok: true }
      }
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
    const saveMeeting = vi.fn(() => {
      throw new Error('Unexpected meeting write in speaker wiring fixture')
    })
    const updateMeetingRecap = vi.fn(() => {
      throw new Error('Unexpected recap write in speaker wiring fixture')
    })
    actualFunction('initializeImportJobs', {
      importJobs: null,
      wireIntelligenceIndexWork: noop,
      ImportJobManager: class {
        constructor(deps: Record<string, any>) {
          captured = deps
        }
      },
      EncryptedImportJobStore: class {},
      createImportMeetingWriteAdapters,
      saveMeeting,
      updateMeetingRecap,
      getSettings: () => ({ asrLanguage: 'auto', asrEngine: 'parakeet', mode: 'meeting' }),
      randomUUID,
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
      resolveLocalSpeechPackPolicy: () => 'offered',
      getAdminLocalSpeechPackPolicy: () => null,
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
    expect(saveMeeting).not.toHaveBeenCalled()
    expect(updateMeetingRecap).not.toHaveBeenCalled()
  })

  it('keeps live and import labels isolated and rejects stale same-job cleanup', async () => {
    const id = realSpeakerId()
    const api = sessionApi({ id })
    const attempt1 = Object.freeze({ jobId: 'job-a', attemptId: 1 })
    const attempt2 = Object.freeze({ jobId: 'job-a', attemptId: 2 })
    api.acceptLiveSpeakerTransition({ on: true, startedAt: 1300 })
    expect(api.beginImportSpeakers(attempt1)).toBe(true)
    await expect(api.labelThemAudio(windowFor(0), 'live:1300', 'live')).resolves.toMatchObject({ name: 'Speaker 1' })
    await expect(
      api.labelThemAudio(windowFor(1), api.captureImportSpeakerKey(attempt1), 'import')
    ).resolves.toMatchObject({ name: 'Speaker 1' })

    api.disposeImportSpeakers(attempt1)
    expect(api.beginImportSpeakers(attempt2)).toBe(true)
    // Manager cleanup is exact-once, but a duplicated late callback must still be harmless.
    api.disposeImportSpeakers(attempt1)
    await expect(
      api.labelThemAudio(windowFor(2), api.captureImportSpeakerKey(attempt2), 'import')
    ).resolves.toMatchObject({ name: 'Speaker 1' })
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

describe('owner-session revocation at the sign-out boundary', () => {
  function signOutHandler(api: SessionApi, order: string[]): (...args: any[]) => Promise<void> {
    return actualIpcHandler('authSignOut', {
      assertMainWindow: vi.fn(),
      hardStopInputSession: api.hardStopInputSession,
      speechDesktop: { invalidate: () => order.push('speech-invalidate') },
      authSignOut: () => order.push('auth-sign-out'),
      importJobs: {
        cancelAll: async () => {
          order.push('import-cancel-all')
        }
      }
    })
  }

  it('revokes owner sessions synchronously, before authSignOut and before any await', async () => {
    const order: string[] = []
    const api = sessionApi({
      id: createSpeakerId(),
      ownerSession: { revokeAll: (reason) => order.push(`owner-revoke-all:${reason}`) }
    })
    const handler = signOutHandler(api, order)

    const pending = handler({})

    // Nothing has been awaited yet: the revocation already ran, ahead of the auth mutation.
    expect(order.slice(0, 2)).toEqual(['owner-revoke-all:sign-out', 'speech-invalidate'])
    expect(order.indexOf('owner-revoke-all:sign-out')).toBeLessThan(order.indexOf('auth-sign-out'))
    await pending
    expect(order.filter((line) => line.startsWith('owner-revoke-all'))).toHaveLength(1)
  })

  it('still signs out when the owner-session authority is not created yet', async () => {
    const order: string[] = []
    const api = sessionApi({ id: createSpeakerId(), ownerSession: null })
    await signOutHandler(api, order)({})
    expect(order).toEqual(['speech-invalidate', 'auth-sign-out', 'import-cancel-all'])
  })
})
