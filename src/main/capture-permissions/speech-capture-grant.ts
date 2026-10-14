export type SpeechCaptureContext = {
  /** Exact Electron WebContents object, kept main-only. */
  webContents: object
  /** Exact main-frame object captured for the accepted Listen owner. */
  frame: object
  /** Main-owned navigation counter; URL strings and numeric ids alone are insufficient authority. */
  navigationEpoch: number
  /** Exact currently accepted main Listen startedAt value. */
  listenStartedAt: number
}

export type PendingSpeechCaptureGrant = object
export type SpeechCaptureTrack = 'microphone' | 'system'
export type SpeechCaptureSource = 'mic' | 'system' | 'both'
export type CapturePermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-required'

type PendingGrantState = { token: PendingSpeechCaptureGrant; context: SpeechCaptureContext }
type FinishOwner = { owner: object; context: SpeechCaptureContext }

type SpeechCaptureAuthorization =
  | {
      ok: false
      code:
        | 'CONTEXT_STALE'
        | 'SOURCE_INVALID'
        | 'TRACKS_INVALID'
        | 'TRACK_NOT_REQUESTED'
        | 'PERMISSION_DENIED'
        | 'LOOPBACK_GRANT_REQUIRED'
    }
  | { ok: true; tracks: SpeechCaptureTrack[]; missingRequested: SpeechCaptureTrack[] }

function validContext(context: SpeechCaptureContext): boolean {
  return (
    context !== null &&
    typeof context === 'object' &&
    context.webContents !== null &&
    typeof context.webContents === 'object' &&
    context.frame !== null &&
    typeof context.frame === 'object' &&
    Number.isSafeInteger(context.navigationEpoch) &&
    context.navigationEpoch > 0 &&
    Number.isSafeInteger(context.listenStartedAt) &&
    context.listenStartedAt > 0
  )
}

function sameContext(left: SpeechCaptureContext | null, right: SpeechCaptureContext): boolean {
  return (
    left !== null &&
    left.webContents === right.webContents &&
    left.frame === right.frame &&
    left.navigationEpoch === right.navigationEpoch &&
    left.listenStartedAt === right.listenStartedAt
  )
}

function copyContext(context: SpeechCaptureContext): SpeechCaptureContext {
  return { ...context }
}

function requestedTracks(source: SpeechCaptureSource): SpeechCaptureTrack[] | null {
  if (source === 'mic') return ['microphone']
  if (source === 'system') return ['system']
  if (source === 'both') return ['microphone', 'system']
  return null
}

/** Main-only facts for a real loopback grant and its bounded Listen owner. */
export class SpeechCaptureGrantRegistry {
  private acceptedContext: SpeechCaptureContext | null = null
  private armed = false
  private pending: PendingGrantState | null = null
  private issuedContext: SpeechCaptureContext | null = null
  private admittedContext: SpeechCaptureContext | null = null
  private finishOwner: FinishOwner | null = null

  /** A new accepted Listen context invalidates pending, issued, and prior finishing facts. */
  acceptListenContext(context: SpeechCaptureContext): boolean {
    this.invalidateAll()
    if (!validContext(context)) return false
    this.acceptedContext = copyContext(context)
    return true
  }

  /** The renderer may clear arm after acquisition; only pending requests are ended by that transition. */
  setArmed(armed: boolean): void {
    this.armed = armed
    if (!armed) this.pending = null
  }

  getAcceptedListenContext(): SpeechCaptureContext | null {
    return this.acceptedContext ? copyContext(this.acceptedContext) : null
  }

  beginPendingGrant(context: SpeechCaptureContext): PendingSpeechCaptureGrant | null {
    if (!this.armed || !validContext(context) || !sameContext(this.acceptedContext, context)) return null
    const token = Object.freeze({})
    this.pending = { token, context: copyContext(context) }
    return token
  }

  /** Recheck after async screen-source acquisition and immediately before invoking Electron's callback. */
  isPendingGrantCurrent(token: PendingSpeechCaptureGrant, context: SpeechCaptureContext): boolean {
    return (
      this.armed &&
      this.pending?.token === token &&
      validContext(context) &&
      sameContext(this.pending.context, context) &&
      sameContext(this.acceptedContext, context)
    )
  }

  /** Record a fact only after Electron's callback returned successfully with actual loopback audio. */
  recordGrantCallbackResult(
    token: PendingSpeechCaptureGrant,
    context: SpeechCaptureContext,
    result: { callbackSucceeded: boolean; audioGranted: boolean }
  ): true | null {
    if (!this.isPendingGrantCurrent(token, context)) return null
    this.pending = null
    if (!result.callbackSucceeded || !result.audioGranted) return null
    this.issuedContext = copyContext(context)
    return true
  }

  hasIssuedLoopbackGrant(context: SpeechCaptureContext): boolean {
    return (
      validContext(context) && sameContext(this.acceptedContext, context) && sameContext(this.issuedContext, context)
    )
  }

  /**
   * Verify requested and actual acquired tracks, permission facts, and loopback ownership.
   * A requested but absent system track is reported as missing, never fabricated.
   */
  authorizeCapturedTracks(input: {
    context: SpeechCaptureContext
    audioSource: SpeechCaptureSource
    capturedTracks: readonly unknown[]
    platform: NodeJS.Platform | string
    microphonePermission: CapturePermissionStatus
    screenPermission: CapturePermissionStatus
    screenDiagnosis?: string
  }): SpeechCaptureAuthorization {
    if (!validContext(input.context) || !sameContext(this.acceptedContext, input.context))
      return { ok: false, code: 'CONTEXT_STALE' }
    const requested = requestedTracks(input.audioSource)
    if (!requested) return { ok: false, code: 'SOURCE_INVALID' }
    if (
      !Array.isArray(input.capturedTracks) ||
      input.capturedTracks.length === 0 ||
      input.capturedTracks.length > 2 ||
      input.capturedTracks.some((track) => track !== 'microphone' && track !== 'system') ||
      new Set(input.capturedTracks).size !== input.capturedTracks.length
    )
      return { ok: false, code: 'TRACKS_INVALID' }
    const tracks = input.capturedTracks as SpeechCaptureTrack[]
    if (tracks.some((track) => !requested.includes(track))) return { ok: false, code: 'TRACK_NOT_REQUESTED' }
    if (tracks.includes('microphone') && !['granted', 'not-required'].includes(input.microphonePermission))
      return { ok: false, code: 'PERMISSION_DENIED' }
    if (tracks.includes('system')) {
      if (!this.hasIssuedLoopbackGrant(input.context)) return { ok: false, code: 'LOOPBACK_GRANT_REQUIRED' }
      if (input.platform === 'darwin' && (input.screenPermission !== 'granted' || input.screenDiagnosis !== 'granted'))
        return { ok: false, code: 'PERMISSION_DENIED' }
      // Windows has no equivalent queryable loopback/TCC status; a screenshot permission probe is unrelated.
      if (input.platform !== 'darwin' && input.platform !== 'win32' && input.screenPermission !== 'granted')
        return { ok: false, code: 'PERMISSION_DENIED' }
    }
    this.admittedContext = copyContext(input.context)
    return {
      ok: true,
      tracks,
      missingRequested: requested.filter((track) => !tracks.includes(track))
    }
  }

  /** A finishing owner can be reserved only after successful capture admission. */
  reserveFinishingOwner(context: SpeechCaptureContext, owner: object): boolean {
    if (
      !validContext(context) ||
      !sameContext(this.acceptedContext, context) ||
      !sameContext(this.admittedContext, context) ||
      !owner
    )
      return false
    if (this.finishOwner) return this.finishOwner.owner === owner && sameContext(this.finishOwner.context, context)
    this.finishOwner = { owner, context: copyContext(context) }
    return true
  }

  /** Normal Stop blocks new starts and drops the fresh grant, while preserving only reserved final drains. */
  normalStop(context: SpeechCaptureContext): boolean {
    if (!validContext(context) || !sameContext(this.acceptedContext, context)) return false
    this.armed = false
    this.pending = null
    this.issuedContext = null
    this.admittedContext = null
    this.acceptedContext = null
    return true
  }

  canFinish(owner: object): boolean {
    return this.finishOwner?.owner === owner
  }

  releaseFinishingOwner(owner: object): void {
    if (this.finishOwner?.owner === owner) this.finishOwner = null
  }

  /** Permission, navigation, renderer, identity, consent, or auth revocation clears every fact. */
  invalidateAll(): void {
    this.acceptedContext = null
    this.armed = false
    this.pending = null
    this.issuedContext = null
    this.admittedContext = null
    this.finishOwner = null
  }
}
