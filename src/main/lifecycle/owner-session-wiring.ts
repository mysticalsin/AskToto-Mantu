import { app, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { createMainTranscriptRevision } from '../features/meetings/main-transcript-revision'
import { bindTranscriptCheckpointStore } from '../features/meetings/transcript-checkpoint-binding'
import { bindMeetingEndClosure, bindOwnerRevocationClosure } from '../features/meetings/session-closure'
import { onDraftMeetingFinalizing } from '../infra/storage/draft-transcript-write-state'
import { createLanguageChangeAudit } from '../ipc/cloud-speech-language-audit'
import { registerOwnerSessionIpc } from '../ipc/register-owner-session'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { authSessionGeneration, requireAuth } from '../auth'
import { auditLog, mainLog } from '../logger'
import { bindMeetingMicRendererReset } from '../meeting-mic-capture-authority'
import { getPublishedSettingsObservation } from '../settings-observation'
import type { SpeechDesktopHooks } from '../speech-desktop-boundary'
import type { RendererResetSource } from '../features/meetings/session-closure'
import { bootstrapLiveMeetingJournal } from './live-meeting-journal-wiring'
import { bindMeetingSpeechInvalidation, bootstrapMeetingSpeech } from './meeting-speech-persistence-wiring'
import { createMainOwnerSessionAuthority, type OwnerSessionAuthority } from './owner-session-authority'

export interface OwnerSessionWiringDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: IpcMainInvokeEvent): void
  currentInputSessionContext(): { authSessionGeneration: number; contextRevision: number }
}

export interface OwnerSessionWiring {
  readonly ownerSession: OwnerSessionAuthority
  readonly authorizeSender: AuthorizeSender
  /** Spread into `registerInputCaptureIpc`. */
  readonly inputCapture: { ownerSession: OwnerSessionAuthority; authorizeSender: AuthorizeSender }
  /** Passed to `speechDesktopBoundaryOptions`: delivered speech feeds the transcript store; language changes are audited. */
  readonly speechHooks: SpeechDesktopHooks
  /** The meeting speech policy + worker facade (kill switch, circuit breaker, invalidation, disposal). */
  readonly meetingSpeech: ReturnType<typeof bootstrapMeetingSpeech>
}

/** The `meetingSpeechWorker` kill switch from the last published settings (managed policy is already merged in). */
function meetingSpeechWorkerEnabled(): boolean {
  const published = getPublishedSettingsObservation()
  return published ? published.readable && published.settings.meetingSpeechWorker !== false : true
}

/**
 * WP02/WP03 main wiring kept out of index.ts: the owner-session authority, its `ownerSession:status` surface and
 * shared sender authorizer, and the transcript revision store fed by delivered cloud speech. Call once from
 * registerIpc, before the speech bootstrap.
 */
export function createOwnerSessionWiring(deps: OwnerSessionWiringDeps): OwnerSessionWiring {
  const { ipcMain, assertMainWindow, currentInputSessionContext } = deps
  // The trusted speech budget must exist before any handler can save, autosave or read a meeting: without it a
  // broker-speech line is refused (fail closed). registerIpc runs before the first window shows and before any
  // boot-work job (draft recovery, retention, brain reads), so this is the earliest main seam that covers them all.
  // The bootstrap also configures the optional worker thread behind the `meetingSpeechWorker` kill switch.
  const meetingSpeech = bootstrapMeetingSpeech({
    readWorkerEnabled: meetingSpeechWorkerEnabled,
    authGeneration: authSessionGeneration,
    audit: (event, record) => auditLog(event, record),
    onWillQuit: (listener) => app.once('will-quit', listener)
  })
  const ownerSession = createMainOwnerSessionAuthority(() => currentInputSessionContext().contextRevision)
  activeOwnerSession = ownerSession
  const authorizeSender = registerOwnerSessionIpc({
    ipcMain,
    assertMainWindow,
    ownerSession,
    currentInputSessionContext
  })
  const transcriptRevision = createMainTranscriptRevision(
    (frame) => ownerSession.current(frame),
    () => currentInputSessionContext().authSessionGeneration
  )
  // The disposers are discarded on purpose: these bindings live for the app lifetime.
  bindOwnerRevocationClosure(ownerSession, transcriptRevision.store)
  bindMeetingSpeechInvalidation(ownerSession, meetingSpeech)
  bindTranscriptCheckpointStore(transcriptRevision.store)
  bindMeetingEndClosure(onDraftMeetingFinalizing, transcriptRevision.store)
  // WP03 live meeting journal: one durable record per committed cloud final, behind the `liveMeetingJournal` switch.
  bootstrapLiveMeetingJournal({
    ipcMain,
    authorizeSender,
    requireAuth: () => requireAuth(),
    store: transcriptRevision.store,
    ownerSession,
    onMeetingEnd: onDraftMeetingFinalizing,
    readSettings: getPublishedSettingsObservation,
    userDataPath: () => app.getPath('userData'),
    authGeneration: authSessionGeneration,
    audit: (event, record) => auditLog(event, { ...record }),
    auditRecovery: (record) => auditLog('meeting.journal.recovery', { ...record }),
    currentOwnerKey: () => ownerSession.currentOwnerKey(),
    onWillQuit: (listener) => app.once('will-quit', listener)
  })
  return {
    ownerSession,
    authorizeSender,
    inputCapture: { ownerSession, authorizeSender },
    meetingSpeech,
    speechHooks: {
      onSegmentDelivered: transcriptRevision.onSegmentDelivered,
      onLanguageChange: createLanguageChangeAudit({
        resolveOwner: (frame) => ownerSession.current(frame),
        audit: (event, record) => auditLog(event, record)
      })
    }
  }
}

/** Process-wide handle on the one authority `createOwnerSessionWiring` built, so earlier-constructed Main objects can
 *  resolve it lazily. Null before registerIpc runs. */
let activeOwnerSession: OwnerSessionAuthority | null = null

/** The owner-session authority, or null until `createOwnerSessionWiring` has run. Resolve it on every use. */
export function currentOwnerSession(): OwnerSessionAuthority | null {
  return activeOwnerSession
}

/** What the input-session lifecycle controller needs: the lazy authority and a record of failed revocations. */
export const ownerSessionLifecycle = {
  current: currentOwnerSession,
  onRevocationError: (reason: string, errorName: string): void =>
    mainLog.error('[input-session] owner-session revocation failed', { reason, error: errorName })
}

type ResetListener = (...args: never[]) => void

/** The WebContents surface the owner-session renderer binding needs. `removeListener` lets it undo only its own listeners. */
export interface OwnerSessionRendererSource extends RendererResetSource {
  readonly id: number
  removeListener?(event: string, listener: ResetListener): unknown
}

export interface OwnerSessionRendererBinder {
  /**
   * Revokes this WebContents' owner sessions when its renderer crashes, is destroyed or replaces its main frame.
   * Returns true when the listeners are installed (or already were), false when binding failed and nothing is left
   * behind. Idempotent per object: the same WebContents never gets a second listener set.
   */
  attach(contents: OwnerSessionRendererSource): boolean
}

/**
 * Per-WebContents `revokeFrame(id, 'renderer-reset')` adapter. The authority is resolved lazily on each event, so a
 * window created before the authority exists is covered once it does. The id is captured at attach time, because
 * `webContents.id` throws after destruction and a replaced window's late events must never consult the current one.
 * Listeners survive crashes and navigations so later sessions on the same surviving WebContents are still reset; the
 * adapter removes only its own listeners when the WebContents is destroyed.
 */
export function createOwnerSessionRendererBinder(
  authority: () => Pick<OwnerSessionAuthority, 'revokeFrame'> | null,
  onError: (message: string, error: unknown) => void = () => undefined
): OwnerSessionRendererBinder {
  const attached = new WeakSet<object>()
  return {
    attach(contents) {
      if (attached.has(contents)) return true
      let id: number
      try {
        id = contents.id
      } catch (error) {
        onError('[owner-session] renderer reset binding skipped: webContents id unavailable', error)
        return false
      }
      const reset = (): void => {
        try {
          authority()?.revokeFrame(id, 'renderer-reset')
        } catch {
          /* a reset never throws into the emitter */
        }
      }
      const installed: Array<readonly [string, ResetListener]> = []
      const listeners: Array<readonly [string, ResetListener]> = [
        ['render-process-gone', reset],
        [
          'destroyed',
          () => {
            reset()
            for (const [event, listener] of installed) contents.removeListener?.(event, listener)
          }
        ],
        [
          'did-start-navigation',
          (_event: unknown, _url: unknown, isInPlace: unknown, isMainFrame: unknown) => {
            if (isMainFrame === true && isInPlace === false) reset()
          }
        ]
      ]
      try {
        for (const [event, listener] of listeners) {
          ;(contents.on as (event: string, listener: ResetListener) => unknown)(event, listener)
          installed.push([event, listener])
        }
      } catch (error) {
        for (const [event, listener] of installed) {
          try {
            contents.removeListener?.(event, listener)
          } catch {
            /* best effort: only our own listeners are touched */
          }
        }
        onError('[owner-session] renderer reset binding failed', error)
        return false
      }
      attached.add(contents)
      return true
    }
  }
}

const rendererBinder = createOwnerSessionRendererBinder(currentOwnerSession, (message, error) =>
  mainLog.error(message, error)
)

/**
 * Binds a main window's WebContents to the renderer-reset boundary: its meeting-mic grants and its owner sessions end
 * together when the renderer crashes, is destroyed or replaces its main frame.
 */
export function bindRendererResets(
  contents: Parameters<typeof bindMeetingMicRendererReset>[0] & OwnerSessionRendererSource,
  meetingMicCaptureAuthority: Parameters<typeof bindMeetingMicRendererReset>[1]
): void {
  bindMeetingMicRendererReset(contents, meetingMicCaptureAuthority)
  rendererBinder.attach(contents)
}
