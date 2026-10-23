import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CloudSpeechSegmentEventSchema } from '@shared/cloud-speech'
import { OWNER_SESSION_IPC } from '@shared/contracts/owner-session'
import { DICTATION_MEMORY_IPC } from '@shared/dictation-memory'
import { IPC } from '@shared/ipc'
import { SESSION_CONTEXT_IPC } from '@shared/session-context-request'
import { ARTIFACT_IPC } from '@shared/artifact'
import type { InputSessionStopReason } from '@shared/input-session'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/user-data', isPackaged: false, once: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  webContents: {},
  shell: {},
  nativeImage: {},
  webFrameMain: { fromId: vi.fn(() => null) }
}))
vi.mock('../auth', () => ({ authStatus: vi.fn(() => ({ signedIn: false })), authSessionGeneration: vi.fn(() => 1) }))
vi.mock('./memory-partition-wiring', () => ({ bootMainMemoryPartitions: vi.fn() }))
vi.mock('../logger', () => ({ auditLog: vi.fn(), mainLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock('../infra/storage/draft-transcript-write-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../infra/storage/draft-transcript-write-state')>()),
  onDraftMeetingFinalizing: vi.fn(() => () => undefined)
}))

import { checkpointAfterDraftSave } from '../features/meetings/transcript-checkpoint-binding'
import { onDraftMeetingFinalizing } from '../infra/storage/draft-transcript-write-state'
import { createRelayRevisionTap, segmentEventToRevisionEvent } from '../features/meetings/relay-revision-adapter'
import { bindOwnerRevocationClosure } from '../features/meetings/session-closure'
import {
  createTranscriptRevisionStore,
  type CheckpointWriter,
  type TranscriptStoreBinding
} from '../features/meetings/transcript-revision-store'
import { InputSessionLifecycleController } from './input-session-lifecycle-controller'
import { installAppQuitLifecycle } from './app-quit-lifecycle'
import { createQuitTrace } from './quit-trace'
import { createOwnerSessionAuthority } from './owner-session-authority'
import { bootMainMemoryPartitions } from './memory-partition-wiring'
import {
  configureMeetingSpeechLimits,
  getMeetingSpeechLimits,
  getMeetingSpeechReadLimitBytes
} from '../features/meetings/meeting-speech'
import { MEETING_SPEECH_LIMITS, MEETING_SPEECH_WORKER_BOUNDS } from '../features/meetings/meeting-speech-policy'
import {
  bindRendererResets,
  createOwnerSessionRendererBinder,
  createOwnerSessionWiring,
  currentMeetingContexts,
  currentOwnerSession,
  ownerSessionLifecycle,
  type OwnerSessionRendererSource
} from './owner-session-wiring'

function wire() {
  const ipcMain = { handle: vi.fn(), on: vi.fn() }
  const wiring = createOwnerSessionWiring({
    ipcMain,
    assertMainWindow: vi.fn(),
    currentInputSessionContext: () => ({ authSessionGeneration: 1, contextRevision: 3 }),
    privateView: () => false
  })
  return { ipcMain, wiring }
}

describe('owner session wiring', () => {
  it('registers the owner-session status channel, the ledger line seam, the live journal write seam and the dictation memory seam (G26), nothing else', () => {
    const { ipcMain } = wire()
    expect(ipcMain.handle.mock.calls.map((call) => call[0])).toEqual([
      OWNER_SESSION_IPC.status,
      SESSION_CONTEXT_IPC.appendLine,
      IPC.appendMeetingJournal,
      ...Object.values(DICTATION_MEMORY_IPC),
      ARTIFACT_IPC.forTurn,
      ARTIFACT_IPC.open,
      ARTIFACT_IPC.reveal
    ])
    expect(ipcMain.on.mock.calls.map((call) => call[0])).toEqual([ARTIFACT_IPC.dragStart])
  })

  it('boots the local memory partitions with the authority it exposes, before it registers any handler (G19)', () => {
    const bootedWith: unknown[] = []
    vi.mocked(bootMainMemoryPartitions).mockImplementationOnce((ownerSession) => {
      bootedWith.push(ownerSession)
      return undefined as never
    })
    const ipcMain = { handle: vi.fn(() => expect(bootedWith).toHaveLength(1)), on: vi.fn() }
    const wiring = createOwnerSessionWiring({
      ipcMain,
      assertMainWindow: vi.fn(),
      currentInputSessionContext: () => ({ authSessionGeneration: 1, contextRevision: 3 }),
      privateView: () => false
    })
    expect(bootedWith).toEqual([wiring.ownerSession])
    expect(ipcMain.handle).toHaveBeenCalled()
  })

  it('installs the trusted meeting speech policy before it registers any handler', () => {
    configureMeetingSpeechLimits(undefined)
    const installedAtFirstHandler: boolean[] = []
    const ipcMain = {
      handle: vi.fn(() => {
        installedAtFirstHandler.push(getMeetingSpeechLimits() !== undefined)
      }),
      on: vi.fn()
    }
    createOwnerSessionWiring({
      ipcMain,
      assertMainWindow: vi.fn(),
      currentInputSessionContext: () => ({ authSessionGeneration: 1, contextRevision: 3 }),
      privateView: () => false
    })
    // Every handler (owner-session status, ledger line seam, live journal seam, the dictation memory seam) registers
    // after the policy is installed.
    expect(installedAtFirstHandler).toEqual(
      Array.from({ length: 3 + Object.values(DICTATION_MEMORY_IPC).length }, () => true)
    )
    expect(getMeetingSpeechLimits()).toEqual(MEETING_SPEECH_LIMITS)
    expect(getMeetingSpeechReadLimitBytes()).toBe(MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes)
  })

  it('exposes the live meeting registry to screen observation and feeds queue health to the G12 recorder', () => {
    const { wiring } = wire()
    expect(currentMeetingContexts()).toBe(wiring.meetingContexts)
  })

  it('hands input capture the same authority and authorizer it exposes', () => {
    const { wiring } = wire()
    expect(wiring.inputCapture.ownerSession).toBe(wiring.ownerSession)
    expect(wiring.inputCapture.authorizeSender).toBe(wiring.authorizeSender)
    expect(typeof wiring.authorizeSender).toBe('function')
  })

  it('feeds delivered speech to the transcript store without throwing on unrelated events', () => {
    const { wiring } = wire()
    const onSegmentDelivered = wiring.speechHooks.onSegmentDelivered
    expect(typeof onSegmentDelivered).toBe('function')
    const owner = {
      captureId: 'b8ff8685-725b-40e0-a8ef-f343bb10b64f',
      generation: 7,
      binding: { processId: 11, routingId: 2, frame: {} },
      captureContext: null
    }
    expect(() => onSegmentDelivered?.(owner as never, { type: 'terminal' } as never)).not.toThrow()
  })

  it('feeds delivered final speech to the main-owned context every output reads (G13)', () => {
    const { wiring } = wire()
    const owner = {
      captureId: 'b8ff8685-725b-40e0-a8ef-f343bb10b64f',
      generation: 1,
      binding: { processId: 11, routingId: 2, frame: {} },
      captureContext: { listenStartedAt: 1_700_000_000_000 }
    }
    const final = CloudSpeechSegmentEventSchema.parse({
      type: 'segment',
      captureId: owner.captureId,
      captureGeneration: 1,
      sequence: 1,
      segment: {
        stream: { generation: 1, track: 'system', epoch: 1 },
        engine: 'deepgram-nova3',
        index: 1,
        revision: 1,
        final: true,
        text: 'wired through the real hook',
        startMs: 0,
        endMs: 400
      }
    })
    wiring.speechHooks.onSegmentDelivered?.(owner as never, final)
    const handle = wiring.meetingContexts.acquire({ processId: 11, routingId: 2 }, 'conversation')
    expect(handle?.snapshot.transcript.segments).toHaveLength(1)
    expect(handle?.check()).toEqual({ state: 'current' })
  })

  it('binds its transcript store for draft checkpoints', async () => {
    wire()
    // No meeting is open, so the bound store answers 'sealed'; an unbound app would answer null.
    await expect(checkpointAfterDraftSave(1_700_000_000_000)).resolves.toEqual({ ok: false, error: 'sealed' })
  })

  it('closes the store, the meeting context and the live journal session when a meeting ends', () => {
    vi.mocked(onDraftMeetingFinalizing).mockClear()
    wire()
    expect(onDraftMeetingFinalizing).toHaveBeenCalledTimes(3)
    expect(typeof vi.mocked(onDraftMeetingFinalizing).mock.calls[0][0]).toBe('function')
  })
})

const M = 1_700_000_000_000
const CAPTURE = '11111111-1111-4111-8111-111111111111'

function segment(sequence: number) {
  return CloudSpeechSegmentEventSchema.parse({
    type: 'segment',
    captureId: CAPTURE,
    captureGeneration: 1,
    sequence,
    segment: {
      stream: { generation: 1, track: 'microphone', epoch: 1 },
      engine: 'deepgram-nova3',
      index: 1,
      revision: 1,
      final: false,
      text: 'hello',
      startMs: 0,
      endMs: 500
    }
  })
}

/** A WebContents stand-in whose `id` throws once destroyed, like the real object. */
class FakeContents extends EventEmitter {
  destroyed = false
  failOnCall = 0
  private registrations = 0
  constructor(private readonly numericId: number) {
    super()
  }
  get id(): number {
    if (this.destroyed) throw new Error('Object has been destroyed')
    return this.numericId
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
  on(event: string | symbol, listener: (...args: never[]) => void): this {
    this.registrations += 1
    if (this.failOnCall > 0 && this.registrations === this.failOnCall) throw new Error('registration failed')
    return super.on(event, listener as (...args: unknown[]) => void)
  }
  count(): number {
    return (
      this.listenerCount('render-process-gone') +
      this.listenerCount('destroyed') +
      this.listenerCount('did-start-navigation')
    )
  }
}

const asSource = (contents: FakeContents): OwnerSessionRendererSource =>
  contents as unknown as OwnerSessionRendererSource
const frameOf = (webContentsId: number) => ({ processId: 10 + webContentsId, routingId: 1 })
const frameOwnerOf = (webContentsId: number) => `${10 + webContentsId}:1` as const
const mainNavigation = (contents: FakeContents) => contents.emit('did-start-navigation', {}, 'file:///x', false, true)

/** Real authority + store + closure binding + lifecycle controller. One store holds one open meeting, so each scenario builds its own world. */
function world(identity: string | null = 'owner-a') {
  const state = { identity, authGeneration: 1, contextRevision: 1 }
  const order: string[] = []
  let session = 0
  const authority = createOwnerSessionAuthority({
    identityId: () => state.identity,
    tenantId: () => 'tenant-a',
    authGeneration: () => state.authGeneration,
    currentContextRevision: () => state.contextRevision,
    salt: () => Buffer.alloc(32, 9),
    webContentsIdOf: (frame) => frame.processId - 10,
    now: () => M,
    uuid: () => `00000000-0000-4000-8000-${String(++session).padStart(12, '0')}`
  })
  const checkpoint = vi.fn<CheckpointWriter>(async () => 'written')
  const store = createTranscriptRevisionStore({ now: () => M, checkpointWriter: checkpoint })
  bindOwnerRevocationClosure(authority, store)
  authority.onRevoked((_ref, reason) => order.push(`owner-revoked:${reason}`))
  const controller = new InputSessionLifecycleController({
    ownerSession: { current: () => authority },
    inputSessionAuthority: {
      hardStop: (reason: InputSessionStopReason) => order.push(`hard-stop:${reason}`),
      hasMeetingReservation: false,
      meetingStartedAt: null,
      releaseMeeting: () => false
    },
    meetingStartActivationAuthority: { revokeAll: () => undefined },
    meetingMicCaptureAuthority: { revokeMeeting: () => undefined },
    meetingMicCaptureRevokedChannel: 'revoked',
    incrementInputSessionContextRevision: () => undefined,
    getWindow: () => null,
    getMeetingCaptureOwnerWebContentsId: () => null,
    setMeetingCaptureOwnerWebContentsId: () => undefined,
    getActiveLiveSpeakerStartedAt: () => null,
    setActiveLiveSpeakerStartedAt: () => undefined,
    discardActiveLiveSpeakerSession: () => undefined,
    closeLiveSpeakerReceipt: () => undefined,
    setLegacyListeningActive: () => undefined,
    setListeningActive: () => undefined,
    setTrayRecording: () => undefined,
    setRecordingPowerSaveBlock: () => undefined,
    parakeetRelease: async () => undefined,
    releaseSpeakerEmbedding: async () => undefined
  } as never)

  function openMeeting(webContentsId: number, startedAt = M) {
    const owner = authority.mint(frameOf(webContentsId), state.contextRevision)
    if (!owner) throw new Error('expected an owner session')
    const binding: TranscriptStoreBinding = {
      meetingStartedAt: startedAt,
      frameOwner: frameOwnerOf(webContentsId),
      owner
    }
    expect(store.open(binding)).toEqual({ ok: true })
    expect(store.apply(binding, segmentEventToRevisionEvent(segment(1))).ok).toBe(true)
    return { owner, binding }
  }
  const lateSegment = (binding: TranscriptStoreBinding) => store.apply(binding, segmentEventToRevisionEvent(segment(2)))
  return { state, order, authority, store, checkpoint, controller, openMeeting, lateSegment }
}

describe('owner session lifecycle boundaries (real authority, store and controller)', () => {
  it.each([
    ['sign-out', 'sign-out'],
    ['auth-revoked', 'auth-changed'],
    ['system-suspend', 'suspend'],
    ['screen-locked', 'lock-screen'],
    ['shutdown', 'quit']
  ] as const)('%s closes the meeting and every current and retained reference once (%s)', (reason, owner) => {
    const w = world()
    const { owner: first, binding } = w.openMeeting(1)
    w.state.contextRevision += 1
    const second = w.authority.mint(frameOf(1), w.state.contextRevision)
    if (!second) throw new Error('expected a refreshed owner session')

    w.controller.hardStopInputSession(reason)
    w.controller.hardStopInputSession(reason)

    expect(w.order.filter((line) => line.startsWith('owner-revoked'))).toEqual([
      `owner-revoked:${owner}`,
      `owner-revoked:${owner}`
    ])
    expect(w.authority.validate(first, frameOf(1))).toEqual({ ok: false, reason: 'revoked' })
    expect(w.authority.validate(second, frameOf(1))).toEqual({ ok: false, reason: 'revoked' })
    expect(w.authority.current(frameOf(1))).toBeNull()
    expect(w.store.snapshot(M)).toBeNull()
    expect(w.lateSegment(binding)).toEqual({ ok: false, reason: 'invalid' })
    expect(w.checkpoint).toHaveBeenCalledTimes(1)
  })

  it('a new session after one boundary is closed by a later boundary', () => {
    const w = world()
    w.openMeeting(1, M)
    w.controller.hardStopInputSession('screen-locked')
    expect(w.store.snapshot(M)).toBeNull()

    const { binding } = w.openMeeting(1, M + 1)
    expect(w.store.snapshot(M + 1)).not.toBeNull()
    w.controller.hardStopInputSession('sign-out')

    expect(w.store.snapshot(M + 1)).toBeNull()
    expect(w.lateSegment(binding)).toEqual({ ok: false, reason: 'invalid' })
    expect(w.checkpoint).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['suspend', 'system-suspend', 'suspend'],
    ['lock-screen', 'screen-locked', 'lock-screen']
  ] as const)('the %s callback captured from the real installer closes the meeting', (event, stop, owner) => {
    const w = world()
    const { binding } = w.openMeeting(1)
    const callbacks = new Map<string, () => void>()
    w.controller.installInputPowerLifecycleHooks(
      (name, callback) => callbacks.set(name, callback),
      () => undefined,
      { error: () => undefined }
    )

    callbacks.get(event)?.()

    expect(w.order).toContain(`hard-stop:${stop}`)
    expect(w.order).toContain(`owner-revoked:${owner}`)
    expect(w.store.snapshot(M)).toBeNull()
    expect(w.lateSegment(binding)).toEqual({ ok: false, reason: 'invalid' })
  })

  it.each(['suspend', 'lock-screen'] as const)('a failed %s registration leaves the other boundary live', (failed) => {
    const w = world()
    w.openMeeting(1)
    const live = failed === 'suspend' ? 'lock-screen' : 'suspend'
    const callbacks = new Map<string, () => void>()
    const ready = w.controller.installInputPowerLifecycleHooks(
      (name, callback) => {
        if (name === failed) throw new Error('registration failed')
        callbacks.set(name, callback)
      },
      () => undefined,
      { error: () => undefined }
    )
    expect(ready).toBe(false)
    callbacks.get(live)?.()
    expect(w.store.snapshot(M)).toBeNull()
  })

  it('a prevented before-quit keeps ownership through the flush; the final will-quit revokes it', () => {
    class App extends EventEmitter {
      quit(): void {
        const event = {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true
          }
        }
        this.emit('before-quit', event)
        if (event.defaultPrevented) return
        this.emit('will-quit')
        this.emit('quit')
      }
      isReady = () => true
      getPath = () => '/private-test-profile'
    }
    const w = world()
    const { owner, binding } = w.openMeeting(1)
    const app = new App()
    let flushing = true
    installAppQuitLifecycle(app, {
      speechPackDesktop: () => ({
        beforeQuit(event: { preventDefault(): void }) {
          if (flushing) event.preventDefault()
        }
      }),
      // index.ts: before-quit only advances the context revision and begins the input shutdown; it never revokes.
      beginInputShutdown: () => w.order.push('begin-input-shutdown'),
      quitTrace: createQuitTrace(false, () => undefined),
      isQuitFlushDone: () => true,
      markQuitFlushDone: () => undefined,
      meetingFlushPending: () => false,
      window: () => null,
      hotkeyChannel: 'hotkey',
      speechDesktop: () => null,
      invalidateCloudSttOwner: () => undefined,
      shutdownInputSessions: () => w.controller.hardStopInputSession('shutdown'),
      setBootPowerSaveBlock: () => undefined,
      endBootWatch: () => undefined,
      globalShortcut: { unregisterAll: () => undefined },
      notifTimer: () => null,
      backgroundTimers: [],
      observability: () => null,
      uptime: () => 1,
      wrapLifecycleListener: (_name: string, listener: () => void) => listener,
      warn: () => undefined
    } as never)

    app.quit()

    expect(w.order).toEqual(['begin-input-shutdown'])
    expect(w.authority.validate(owner, frameOf(1))).toEqual({ ok: true })
    expect(w.store.apply(binding, segmentEventToRevisionEvent(segment(2))).ok).toBe(true)
    expect(w.checkpoint).not.toHaveBeenCalled()

    flushing = false
    app.quit()

    expect(w.order).toContain('owner-revoked:quit')
    expect(w.authority.validate(owner, frameOf(1))).toEqual({ ok: false, reason: 'revoked' })
    expect(w.store.snapshot(M)).toBeNull()
    expect(w.lateSegment(binding)).toEqual({ ok: false, reason: 'invalid' })
    expect(w.checkpoint).toHaveBeenCalledTimes(1)
  })

  it('window-hidden, cancelled, user-stop and owner-replaced leave the meeting and sessions open', () => {
    const w = world()
    const { owner, binding } = w.openMeeting(1)
    for (const reason of ['window-hidden', 'cancelled', 'user-stop', 'owner-replaced'] as const) {
      w.controller.hardStopInputSession(reason)
    }
    expect(w.authority.validate(owner, frameOf(1))).toEqual({ ok: true })
    expect(w.store.snapshot(M)).not.toBeNull()
    expect(w.lateSegment(binding).ok).toBe(true)
  })

  it('a meeting opened while signed out survives global revocation but closes when its sender resets', () => {
    const w = world(null)
    const sender = new FakeContents(1)
    const tap = createRelayRevisionTap({ store: w.store, resolveOwner: () => w.authority.current(frameOf(1)) })
    const owner = {
      captureId: CAPTURE,
      generation: 1,
      binding: { processId: 11, routingId: 1, frame: {}, sender },
      captureContext: { listenStartedAt: M }
    }
    tap(owner as never, segment(1))
    expect(w.store.snapshot(M)).not.toBeNull()
    expect(w.store.bindingOf(M)).toEqual({ frameOwner: '11:1', ownerKey: null })

    w.controller.hardStopInputSession('sign-out')
    w.controller.hardStopInputSession('shutdown')
    expect(w.store.snapshot(M)).not.toBeNull()

    sender.emit('render-process-gone')
    expect(w.store.snapshot(M)).toBeNull()
  })
})

describe('owner session renderer binder', () => {
  it('resets only the matching WebContents, ignoring subframe and in-place navigation', () => {
    const w = world()
    const binder = createOwnerSessionRendererBinder(() => w.authority)
    const c1 = new FakeContents(1)
    const c2 = new FakeContents(2)
    expect(binder.attach(asSource(c1))).toBe(true)
    expect(binder.attach(asSource(c2))).toBe(true)
    const { owner: ref1, binding } = w.openMeeting(1)
    const ref2 = w.authority.mint(frameOf(2), w.state.contextRevision)
    if (!ref2) throw new Error('expected second owner session')

    c1.emit('did-start-navigation', {}, 'file:///x', true, true)
    c1.emit('did-start-navigation', {}, 'file:///x', false, false)
    c2.emit('render-process-gone')
    expect(w.authority.validate(ref1, frameOf(1))).toEqual({ ok: true })
    expect(w.store.snapshot(M)).not.toBeNull()
    expect(w.authority.validate(ref2, frameOf(2))).toEqual({ ok: false, reason: 'revoked' })

    mainNavigation(c1)
    expect(w.authority.validate(ref1, frameOf(1))).toEqual({ ok: false, reason: 'revoked' })
    expect(w.store.snapshot(M)).toBeNull()
    expect(w.lateSegment(binding)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('keeps its listeners so a later meeting on the same surviving WebContents is reset again', () => {
    const w = world()
    const binder = createOwnerSessionRendererBinder(() => w.authority)
    const contents = new FakeContents(1)
    binder.attach(asSource(contents))
    w.openMeeting(1, M)
    contents.emit('render-process-gone')
    expect(w.store.snapshot(M)).toBeNull()

    w.openMeeting(1, M + 1)
    mainNavigation(contents)
    expect(w.store.snapshot(M + 1)).toBeNull()

    w.openMeeting(1, M + 2)
    contents.emit('render-process-gone')
    expect(w.store.snapshot(M + 2)).toBeNull()
    expect(w.checkpoint).toHaveBeenCalledTimes(3)
  })

  it('installs exactly one listener set per object, however often it is attached', () => {
    const binder = createOwnerSessionRendererBinder(() => null)
    const contents = new FakeContents(1)
    expect(binder.attach(asSource(contents))).toBe(true)
    expect(binder.attach(asSource(contents))).toBe(true)
    expect(binder.attach(asSource(contents))).toBe(true)
    expect(contents.count()).toBe(3)
  })

  it('binds before the authority exists and starts revoking once it does', () => {
    const w = world()
    let authority: typeof w.authority | null = null
    const binder = createOwnerSessionRendererBinder(() => authority)
    const contents = new FakeContents(1)
    binder.attach(asSource(contents))
    expect(() => contents.emit('render-process-gone')).not.toThrow()

    authority = w.authority
    w.openMeeting(1)
    contents.emit('render-process-gone')
    expect(w.store.snapshot(M)).toBeNull()
  })

  it('treats a replacement WebContents with the same numeric id as its own object, and old-window events never reach a successor', () => {
    const w = world()
    const binder = createOwnerSessionRendererBinder(() => w.authority)
    const oldWindow = new FakeContents(1)
    const replacement = new FakeContents(2)
    binder.attach(asSource(oldWindow))
    binder.attach(asSource(replacement))
    const sameIdNewObject = new FakeContents(1)
    expect(binder.attach(asSource(sameIdNewObject))).toBe(true)
    expect(sameIdNewObject.count()).toBe(3)

    const { owner } = w.openMeeting(2)
    oldWindow.destroy()
    oldWindow.emit('render-process-gone')
    mainNavigation(oldWindow)
    expect(w.authority.validate(owner, frameOf(2))).toEqual({ ok: true })
    expect(w.store.snapshot(M)).not.toBeNull()
  })

  it('captures the id at attach time, so cleanup works after the id starts throwing', () => {
    const w = world()
    const binder = createOwnerSessionRendererBinder(() => w.authority)
    const contents = new FakeContents(1)
    binder.attach(asSource(contents))
    const { owner } = w.openMeeting(1)

    expect(() => contents.destroy()).not.toThrow()

    expect(w.authority.validate(owner, frameOf(1))).toEqual({ ok: false, reason: 'revoked' })
    expect(w.store.snapshot(M)).toBeNull()
  })

  it('refuses to bind, leaving nothing behind, when the id is already unreadable', () => {
    const onError = vi.fn()
    const binder = createOwnerSessionRendererBinder(() => null, onError)
    const contents = new FakeContents(1)
    contents.destroyed = true
    expect(binder.attach(asSource(contents))).toBe(false)
    expect(contents.count()).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('removes only its own listeners on destruction', () => {
    const binder = createOwnerSessionRendererBinder(() => null)
    const contents = new FakeContents(1)
    const foreignGone = vi.fn()
    const foreignDestroyed = vi.fn()
    contents.on('render-process-gone', foreignGone)
    contents.on('destroyed', foreignDestroyed)
    binder.attach(asSource(contents))
    expect(contents.count()).toBe(5)

    contents.destroy()

    expect(foreignDestroyed).toHaveBeenCalledTimes(1)
    expect(contents.listeners('render-process-gone')).toEqual([foreignGone])
    expect(contents.listeners('destroyed')).toEqual([foreignDestroyed])
    expect(contents.listenerCount('did-start-navigation')).toBe(0)
  })

  it('cleans up a partial registration and lets the same object attach again later', () => {
    const w = world()
    const onError = vi.fn()
    const binder = createOwnerSessionRendererBinder(() => w.authority, onError)
    const contents = new FakeContents(1)
    contents.failOnCall = 3

    expect(binder.attach(asSource(contents))).toBe(false)
    expect(contents.count()).toBe(0)
    expect(onError).toHaveBeenCalledTimes(1)

    contents.failOnCall = 0
    expect(binder.attach(asSource(contents))).toBe(true)
    expect(contents.count()).toBe(3)
  })

  it('contains a throwing authority so the emitter never sees the exception', () => {
    const binder = createOwnerSessionRendererBinder(() => ({
      revokeFrame: () => {
        throw new Error('boom')
      }
    }))
    const contents = new FakeContents(1)
    binder.attach(asSource(contents))
    expect(() => contents.emit('render-process-gone')).not.toThrow()
    expect(() => mainNavigation(contents)).not.toThrow()
    expect(() => contents.destroy()).not.toThrow()
  })

  it('leaves meetings opened while signed out alone on frame revocation', () => {
    const w = world(null)
    const binder = createOwnerSessionRendererBinder(() => w.authority)
    const contents = new FakeContents(1)
    binder.attach(asSource(contents))
    const binding: TranscriptStoreBinding = { meetingStartedAt: M, frameOwner: frameOwnerOf(1), owner: null }
    expect(w.store.open(binding)).toEqual({ ok: true })
    contents.emit('render-process-gone')
    expect(w.store.snapshot(M)).not.toBeNull()
  })
})

describe('createOwnerSessionWiring retains its authority for lazy lookup', () => {
  it('exposes the one authority through currentOwnerSession and binds Main windows to it', () => {
    const { wiring } = wire()
    expect(currentOwnerSession()).toBe(wiring.ownerSession)

    const revokeFrame = vi.spyOn(wiring.ownerSession, 'revokeFrame')
    const contents = new FakeContents(5)
    const revokeWebContents = vi.fn()
    bindRendererResets(asSource(contents) as never, { revokeWebContents } as never)
    bindRendererResets(asSource(contents) as never, { revokeWebContents } as never)

    mainNavigation(contents)
    expect(revokeFrame).toHaveBeenCalledExactlyOnceWith(5, 'renderer-reset')
    expect(revokeWebContents).toHaveBeenCalledWith(5, 'renderer-reset')
  })

  it('records a failed revocation through the main log with the reason and error name only', async () => {
    const { mainLog } = await import('../logger')
    ownerSessionLifecycle.onRevocationError('sign-out', 'TypeError')
    expect(mainLog.error).toHaveBeenCalledWith('[input-session] owner-session revocation failed', {
      reason: 'sign-out',
      error: 'TypeError'
    })
    expect(ownerSessionLifecycle.current).toBe(currentOwnerSession)
  })
})
