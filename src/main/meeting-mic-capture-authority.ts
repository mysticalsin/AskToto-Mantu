import type { InputSessionContext, InputSessionStopReason, MeetingMicCaptureGrant } from '@shared/input-session'

export type MeetingMicCaptureState = 'pending' | 'permission-authorized' | 'established'

export type MeetingMicCaptureOwner = {
  readonly captureId: string
  readonly startedAt: number
  readonly webContentsId: number
  readonly authSessionGeneration: number
  readonly contextRevision: number
  readonly requestingUrl: string
  state: MeetingMicCaptureState
}

export type MeetingMicCaptureFrame = {
  readonly webContentsId: number
  readonly isTopFrame: boolean
  readonly url: string
}

export type MeetingMicCaptureCurrentState = {
  readonly mainWebContentsId: number | null
  readonly isWindowVisible: boolean
  readonly isAuthenticated: boolean
  readonly currentUrl: string
  readonly context: InputSessionContext
  readonly meetingStartedAt: number | null
}

export interface MeetingMicCaptureAuthorityDependencies {
  currentState(): MeetingMicCaptureCurrentState
  createCaptureId(): string
  onRevoked(owner: Readonly<MeetingMicCaptureOwner>, reason: InputSessionStopReason): void
}

/** Main-owned admission, confirmation, and exact cleanup for live-meeting microphone captures. */
export class MeetingMicCaptureAuthority {
  readonly #deps: MeetingMicCaptureAuthorityDependencies
  readonly #owners = new Map<string, MeetingMicCaptureOwner>()

  constructor(deps: MeetingMicCaptureAuthorityDependencies) {
    this.#deps = deps
  }

  admit(frame: MeetingMicCaptureFrame, startedAt: number): MeetingMicCaptureGrant | null {
    const current = this.#deps.currentState()
    if (
      !this.#frameMatchesCurrentMain(frame, current) ||
      !current.isWindowVisible ||
      !current.isAuthenticated ||
      current.meetingStartedAt !== startedAt
    )
      return null

    const samePhysicalOwner = (owner: MeetingMicCaptureOwner): boolean =>
      owner.webContentsId === frame.webContentsId && owner.startedAt === startedAt
    // Context/URL revisions can advance when an established stream survives hide/show. Keep this
    // physical meeting owner exclusive until its exact capture ID is released; the caller cannot
    // create a concurrent stream simply by obtaining a newer context tuple.
    if ([...this.#owners.values()].some(samePhysicalOwner)) return null
    const captureId = this.#deps.createCaptureId()
    if (!captureId || this.#owners.has(captureId)) return null

    const owner: MeetingMicCaptureOwner = {
      captureId,
      startedAt,
      webContentsId: frame.webContentsId,
      authSessionGeneration: current.context.authSessionGeneration,
      contextRevision: current.context.contextRevision,
      requestingUrl: current.currentUrl,
      state: 'pending'
    }
    this.#owners.set(owner.captureId, owner)
    return { captureId: owner.captureId, startedAt: owner.startedAt }
  }

  /** Atomically consume the sole pending admission matching this current top-frame request. */
  claimPermissionRequest(frame: MeetingMicCaptureFrame): boolean {
    const current = this.#deps.currentState()
    if (
      !this.#frameMatchesCurrentMain(frame, current) ||
      !current.isWindowVisible ||
      !current.isAuthenticated ||
      current.meetingStartedAt === null
    )
      return false
    const matches = (owner: MeetingMicCaptureOwner): boolean =>
      owner.webContentsId === frame.webContentsId &&
      owner.startedAt === current.meetingStartedAt &&
      owner.authSessionGeneration === current.context.authSessionGeneration &&
      owner.contextRevision === current.context.contextRevision &&
      owner.requestingUrl === current.currentUrl
    const pending = [...this.#owners.values()].filter((owner) => owner.state === 'pending' && matches(owner))
    const otherUnresolved = [...this.#owners.values()].some(
      (owner) => owner.state === 'permission-authorized' && matches(owner)
    )
    if (pending.length !== 1 || otherUnresolved) return false
    pending[0]!.state = 'permission-authorized'
    return true
  }

  confirm(frame: MeetingMicCaptureFrame, captureId: string, startedAt: number): boolean {
    const owner = this.#owners.get(captureId)
    if (!owner || owner.state !== 'permission-authorized' || owner.startedAt !== startedAt) return false
    const current = this.#deps.currentState()
    if (
      !this.#frameMatchesCurrentMain(frame, current) ||
      !current.isWindowVisible ||
      !current.isAuthenticated ||
      current.meetingStartedAt !== startedAt ||
      owner.webContentsId !== frame.webContentsId ||
      owner.authSessionGeneration !== current.context.authSessionGeneration ||
      owner.contextRevision !== current.context.contextRevision ||
      owner.requestingUrl !== current.currentUrl
    )
      return false
    owner.state = 'established'
    return true
  }

  /** Release is exact-ID cleanup and remains valid after the meeting reservation changes. */
  release(webContentsId: number, captureId: string): boolean {
    const owner = this.#owners.get(captureId)
    if (!owner || owner.webContentsId !== webContentsId) return false
    return this.#owners.delete(captureId)
  }

  hasPermissionCheckOwner(
    webContentsId: number,
    startedAt: number | null,
    context: Pick<InputSessionContext, 'authSessionGeneration' | 'contextRevision'>,
    requestingUrl: string
  ): boolean {
    if (startedAt === null) return false
    return [...this.#owners.values()].some(
      (owner) =>
        owner.state === 'permission-authorized' &&
        owner.webContentsId === webContentsId &&
        owner.startedAt === startedAt &&
        owner.authSessionGeneration === context.authSessionGeneration &&
        owner.contextRevision === context.contextRevision &&
        owner.requestingUrl === requestingUrl
    )
  }

  hasPermissionRequestOwner(
    webContentsId: number,
    startedAt: number | null,
    context: Pick<InputSessionContext, 'authSessionGeneration' | 'contextRevision'>,
    requestingUrl: string
  ): boolean {
    if (startedAt === null) return false
    return [...this.#owners.values()].some(
      (owner) =>
        owner.state === 'pending' &&
        owner.webContentsId === webContentsId &&
        owner.startedAt === startedAt &&
        owner.authSessionGeneration === context.authSessionGeneration &&
        owner.contextRevision === context.contextRevision &&
        owner.requestingUrl === requestingUrl
    )
  }

  revokeMeeting(startedAt: number | null, reason: InputSessionStopReason): void {
    for (const [captureId, owner] of this.#owners) {
      if (owner.startedAt !== startedAt) continue
      this.#revoke(captureId, owner, reason)
    }
  }

  revokePending(reason: InputSessionStopReason): void {
    for (const [captureId, owner] of this.#owners) {
      if (owner.state === 'established') continue
      this.#revoke(captureId, owner, reason)
    }
  }

  /** Revoke every owner (pending, permission-authorized, established) bound to one webContents. */
  revokeWebContents(webContentsId: number, reason: InputSessionStopReason): void {
    for (const [captureId, owner] of this.#owners) {
      if (owner.webContentsId !== webContentsId) continue
      this.#revoke(captureId, owner, reason)
    }
  }

  #frameMatchesCurrentMain(frame: MeetingMicCaptureFrame, current: MeetingMicCaptureCurrentState): boolean {
    return (
      frame.webContentsId === current.mainWebContentsId &&
      frame.isTopFrame &&
      !!current.currentUrl &&
      frame.url === current.currentUrl
    )
  }

  #revoke(captureId: string, owner: MeetingMicCaptureOwner, reason: InputSessionStopReason): void {
    this.#owners.delete(captureId)
    this.#deps.onRevoked(owner, reason)
  }
}

/** Structural subset of Electron WebContents needed to observe renderer resets (keeps electron out of this module). */
export interface RendererResetSource {
  readonly id: number
  on(event: 'render-process-gone', listener: () => void): unknown
  on(event: 'destroyed', listener: () => void): unknown
  on(
    event: 'did-start-navigation',
    listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void
  ): unknown
}

/** Free the meeting-mic owner of a webContents when its renderer crashes, is destroyed, or navigates away. */
export function bindMeetingMicRendererReset(
  contents: RendererResetSource,
  authority: Pick<MeetingMicCaptureAuthority, 'revokeWebContents'>
): void {
  // webContents.id must not be read after destruction, so capture it once here.
  const id = contents.id
  contents.on('render-process-gone', () => authority.revokeWebContents(id, 'renderer-reset'))
  contents.on('destroyed', () => authority.revokeWebContents(id, 'renderer-reset'))
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame === true && isInPlace === false) authority.revokeWebContents(id, 'renderer-reset')
  })
}
