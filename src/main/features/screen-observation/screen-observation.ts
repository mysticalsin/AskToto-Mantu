import { createHash } from 'node:crypto'
import {
  screenSourceId,
  type ScreenObservationIdentity,
  type ScreenRegion,
  type ScreenScope
} from '@shared/screen-observation'
import { createKeyedSingleFlight } from '../../screen-capture'

/**
 * Screen observation (G16, CAP-10): the one place a capture of the user's screen is admitted, stamped and,
 * when access is withdrawn, dropped.
 *
 *  - Admission. A capture runs only for a named trigger: an Ask or an explicit capture (`ask`), the hover or
 *    press on the Capture button (`prewarm`), the Settings self-check (`check`), or the opted-in background
 *    reader (`background`, which also needs its setting on at that moment). Nothing here has a timer or a
 *    listener that captures: with no trigger, no frame is taken. Locked or suspended means no trigger is admitted.
 *  - Identity. Every frame carries a source id, a scope, a monotonic sequence and the generation it was taken in.
 *  - Revocation. `revoke()` moves the generation, forgets the reusable frame and un-shares in-flight captures.
 *    A capture that finishes under an older generation is dropped with a typed refusal and never cached.
 *  - Send. `checkSend()` refuses a frame this module issued whose generation is no longer current.
 *
 * Electron-free and dependency-injected, so every rule is tested without a display.
 */

export type ScreenCaptureReason = 'ask' | 'prewarm' | 'check' | 'background'
const CAPTURE_REASONS: ReadonlySet<string> = new Set<ScreenCaptureReason>(['ask', 'prewarm', 'check', 'background'])

export type ScreenRevocationReason =
  | 'permission-revoked'
  | 'private-view'
  | 'signed-out'
  | 'screen-locked'
  | 'suspended'
  | 'session-ended'

export type ScreenRefusalCode = 'idle' | 'background-off' | 'locked' | 'scope-unsupported' | 'stale'

const REFUSAL_MESSAGES: Record<ScreenRefusalCode, string> = {
  idle: 'Métis only looks at the screen when you ask it to.',
  'background-off': 'Background screen context is off.',
  locked: 'Métis does not look at the screen while it is locked or the computer is asleep.',
  'scope-unsupported': 'Capturing a single window is not available yet. Capture the display or a region.',
  stale: 'The screen capture was cancelled because access to the screen changed. Capture the screen again.'
}
const STALE_SEND_MESSAGE = 'That screenshot is no longer current. Capture the screen again.'

export class ScreenObservationRefusedError extends Error {
  readonly code: ScreenRefusalCode
  constructor(code: ScreenRefusalCode) {
    super(REFUSAL_MESSAGES[code])
    this.name = 'ScreenObservationRefusedError'
    this.code = code
  }
}

/** Legacy `getScreenshot(phase)` names mapped onto triggers. Anything else is not a trigger. */
export function captureReasonForPhase(phase?: string): ScreenCaptureReason | null {
  if (phase === undefined) return 'ask'
  if (phase === 'prewarm') return 'prewarm'
  if (phase === 'screen-check') return 'check'
  if (phase === 'bg-screen') return 'background'
  return null
}

export interface CapturedFrame {
  image: string
  width: number
  height: number
  /** The display the frame is really of. */
  dispId: number
  displayMismatch: boolean
}

export interface ScreenShot extends CapturedFrame {
  capturedAt: number
  observation: ScreenObservationIdentity
}

export interface ScreenObservationDeps {
  /** One native capture of a display, optionally cropped to a region. */
  captureOnce: (request: { displayId: number; region?: ScreenRegion }) => Promise<CapturedFrame>
  cursorDisplayId: () => number
  privateViewOn: () => boolean
  privateViewBlockedError: () => Error
  /** The OS answer for Screen Recording: 'granted', 'denied', 'restricted', 'not-determined' or 'unknown'. */
  screenAccess: () => string
  /** The opt-in `backgroundScreenContext` setting, read at the moment a background capture is requested. */
  backgroundAllowed: () => boolean
  now?: () => number
  /** How long a whole-display frame is reused for the next ask. */
  reuseMs?: number
  /** How many issued frames are remembered for the send check. */
  issuedLimit?: number
  audit?: (
    event: 'capture.screen' | 'capture.blocked' | 'capture.failed' | 'capture.revoked' | 'capture.dropped',
    data?: Record<string, unknown>
  ) => void
}

export type SendVerdict = { ok: true; known: boolean } | { ok: false; reason: 'stale'; message: string }

export interface ScreenObservation {
  capture: (request: { reason: string; phase?: string; scope?: ScreenScope }) => Promise<ScreenShot>
  generation: () => number
  revoke: (reason: ScreenRevocationReason) => number
  /** Read Private View and the Screen Recording grant; a withdrawal since the last read revokes. */
  reconcile: () => void
  /** reconcile(), then whether Screen Recording is granted right now. */
  permissionGranted: () => boolean
  noteScreenLocked: (locked: boolean) => void
  noteSuspended: (suspended: boolean) => void
  checkSend: (image: string) => SendVerdict
}

const DEFAULT_REUSE_MS = 4000
const DEFAULT_ISSUED_LIMIT = 16
const DISPLAY_SCOPE: ScreenScope = { kind: 'display' }

const fingerprint = (image: string): string => createHash('sha256').update(image).digest('hex')

export function createScreenObservation(deps: ScreenObservationDeps): ScreenObservation {
  const now = deps.now ?? (() => Date.now())
  const reuseMs = deps.reuseMs ?? DEFAULT_REUSE_MS
  const issuedLimit = deps.issuedLimit ?? DEFAULT_ISSUED_LIMIT
  const audit = deps.audit ?? (() => {})

  let generation = 0
  let sequence = 0
  let locked = false
  let suspended = false
  let lastGranted: boolean | null = null
  let lastPrivateView: boolean | null = null
  let reusable: { shot: ScreenShot; at: number } | null = null
  const issued = new Map<string, ScreenObservationIdentity>()

  // Coalesce identical requests only. The key carries the generation, so a request made after a revocation
  // can never ride a capture that began before it.
  const sharedCapture = createKeyedSingleFlight<string, CapturedFrame>((key) => {
    const { displayId, region } = JSON.parse(key) as { generation: number; displayId: number; region?: ScreenRegion }
    return deps.captureOnce(region ? { displayId, region } : { displayId })
  })

  function revoke(reason: ScreenRevocationReason): number {
    generation += 1
    reusable = null
    audit('capture.revoked', { reason, generation })
    return generation
  }

  function reconcile(): void {
    const access = deps.screenAccess()
    if (access === 'granted') lastGranted = true
    else if (access === 'denied' || access === 'restricted') {
      if (lastGranted) revoke('permission-revoked')
      lastGranted = false
    }
    const privateView = deps.privateViewOn()
    if (privateView && lastPrivateView === false) revoke('private-view')
    lastPrivateView = privateView
  }

  function remember(identity: ScreenObservationIdentity, image: string): void {
    const key = fingerprint(image)
    issued.delete(key)
    issued.set(key, identity)
    while (issued.size > issuedLimit) {
      const oldest = issued.keys().next().value
      if (oldest === undefined) break
      issued.delete(oldest)
    }
  }

  async function capture(request: { reason: string; phase?: string; scope?: ScreenScope }): Promise<ScreenShot> {
    const { reason, phase } = request
    const scope = request.scope ?? DISPLAY_SCOPE
    if (!CAPTURE_REASONS.has(reason)) throw new ScreenObservationRefusedError('idle')
    const quiet = reason === 'prewarm'
    const tag = phase ? { phase } : {}
    reconcile()
    if (reason === 'background' && !deps.backgroundAllowed()) throw new ScreenObservationRefusedError('background-off')
    if (locked || suspended) throw new ScreenObservationRefusedError('locked')
    if (scope.kind === 'window') throw new ScreenObservationRefusedError('scope-unsupported')
    // Private View promises Métis neither looks at nor sends the screen. A prewarm is an opportunistic
    // cache-fill, so auditing its blocks would write a line per hover (pure noise); real asks audit.
    if (deps.privateViewOn()) {
      if (!quiet) audit('capture.blocked', { reason: 'private_view', ...tag })
      throw deps.privateViewBlockedError()
    }
    const startedIn = generation
    const displayId = deps.cursorDisplayId()
    const wholeDisplay = scope.kind === 'display'
    if (
      wholeDisplay &&
      reusable &&
      now() - reusable.at < reuseMs &&
      reusable.shot.observation.sourceId === screenSourceId(scope, displayId)
    ) {
      return reusable.shot
    }
    let frame: CapturedFrame
    try {
      const key = JSON.stringify({
        generation: startedIn,
        displayId,
        ...(scope.kind === 'region' ? { region: scope.region } : {})
      })
      frame = await sharedCapture(key)
    } catch (error) {
      if (!quiet) audit('capture.failed', { reason: error instanceof Error ? error.message : String(error), ...tag })
      reconcile()
      throw error
    }
    // A Private View switched on while the capture was in flight still has to win, with its own wording,
    // whether or not a settings write reached reconcile() first.
    if (deps.privateViewOn()) {
      if (!quiet) audit('capture.blocked', { reason: 'private_view', at: 'post_capture', ...tag })
      throw deps.privateViewBlockedError()
    }
    if (generation !== startedIn) {
      audit('capture.dropped', { reason: 'stale_generation', at: 'post_capture', generation, startedIn, ...tag })
      throw new ScreenObservationRefusedError('stale')
    }
    // A drift we DETECTED and flagged is handed to the renderer as the documented soft "captured a different
    // monitor" notice. An UNFLAGGED drift is a bug we cannot explain, so it still hard-fails.
    if (frame.dispId !== displayId && !frame.displayMismatch) {
      throw new Error('Métis captured a different display than requested. Try again.')
    }
    const capturedAt = now()
    sequence += 1
    const observation: ScreenObservationIdentity = {
      observationId: `obs-${sequence}`,
      sequence,
      sourceId: screenSourceId(scope, frame.dispId),
      scope: scope.kind,
      generation: startedIn,
      capturedAt
    }
    const shot: ScreenShot = { ...frame, capturedAt, observation }
    remember(observation, frame.image)
    if (wholeDisplay) reusable = { shot, at: capturedAt }
    audit('capture.screen', { width: frame.width, height: frame.height, bytes: frame.image.length, ...tag })
    return shot
  }

  return {
    capture,
    generation: () => generation,
    revoke,
    reconcile,
    permissionGranted: () => {
      reconcile()
      return deps.screenAccess() === 'granted'
    },
    noteScreenLocked: (next) => {
      if (next && !locked) revoke('screen-locked')
      locked = next
    },
    noteSuspended: (next) => {
      if (next && !suspended) revoke('suspended')
      suspended = next
    },
    checkSend: (image) => {
      reconcile() // a Screen Recording grant withdrawn without an event is still withdrawn at the moment of sending
      const identity = issued.get(fingerprint(image))
      if (!identity) return { ok: true, known: false }
      if (identity.generation !== generation) return { ok: false, reason: 'stale', message: STALE_SEND_MESSAGE }
      return { ok: true, known: true }
    }
  }
}
