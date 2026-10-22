import type { InputPurpose } from '@shared/input-session'
import type { InputSessionContext, InputSessionLease, InputSessionRevoked, MeetingMicCaptureRevoked } from '@shared/ipc'

type Cleanup = () => void
type SessionRecord = {
  readonly lease: InputSessionLease
  readonly context: InputSessionContext
  readonly cleanups: Set<Cleanup>
  revoked: boolean
}

const sessions = new Map<string, SessionRecord>()
type MeetingRecord = { readonly startedAt: number; readonly cleanups: Set<Cleanup>; revoked: boolean }
const meetingCaptures = new Map<string, MeetingRecord>()
let unsubscribe: (() => void) | null = null
let meetingUnsubscribe: (() => void) | null = null

function receiveRevocation(event: InputSessionRevoked): void {
  const record = sessions.get(event.sessionId)
  if (!record || record.lease.revision !== event.revision) return
  record.revoked = true
  for (const cleanup of [...record.cleanups]) {
    try {
      cleanup()
    } catch {
      /* continue releasing the rest of this exact session */
    }
  }
  sessions.delete(event.sessionId)
}

function ensureRevocationListener(): void {
  if (!unsubscribe) unsubscribe = window.toto.onInputSessionRevoked(receiveRevocation)
}

function receiveMeetingRevocation(event: MeetingMicCaptureRevoked): void {
  if (!event.captureId) return
  const record = meetingCaptures.get(event.captureId)
  if (!record || record.startedAt !== event.startedAt) return
  record.revoked = true
  for (const cleanup of [...record.cleanups]) {
    try {
      cleanup()
    } catch {
      /* release remaining resources for this exact meeting capture */
    }
  }
  meetingCaptures.delete(event.captureId)
}

export interface InputMicAdmission {
  readonly sessionId: string
  readonly revoked: boolean
  onRevoke(cleanup: Cleanup): () => void
  release(): Promise<void>
}

export interface AdmittedMicrophone {
  readonly stream: MediaStream
  readonly admission: InputMicAdmission
  /** Stop only this stream's physical tracks; the Main lease remains active. */
  stopMedia(): void
}

export interface InteractiveMicOptions {
  /**
   * Who decides what a device change means. By default a device change releases the lease and stops the stream.
   * A caller that must not lose audio it already accepted (the command capture, G18) passes this instead: the
   * lease and the stream stay until the caller releases them, and the caller is told.
   */
  onDeviceChange?: () => void
}

/** Obtain main-process authority before opening the renderer microphone. */
export async function acquireInteractiveMic(
  constraints: MediaStreamConstraints,
  purpose: InputPurpose,
  source: 'deliberate-talk' | 'push-to-talk' | 'application-probe' = 'deliberate-talk',
  signal?: AbortSignal,
  options: InteractiveMicOptions = {}
): Promise<AdmittedMicrophone> {
  if (signal?.aborted) throw new DOMException('Microphone admission was cancelled.', 'AbortError')
  ensureRevocationListener()
  const context = await window.toto.getInputSessionContext()
  if (signal?.aborted) throw new DOMException('Microphone admission was cancelled.', 'AbortError')
  if (!context) throw new Error('Microphone admission is unavailable for this window.')
  const activation = source === 'application-probe' ? 'ambient' : 'explicit'
  const result = await window.toto.startInputSession({ source, purpose, activation }, context)
  if (!result.ok) throw new Error(`Microphone admission denied: ${result.reason}`)
  if (signal?.aborted) {
    await window.toto.stopInputSession({ sessionId: result.lease.sessionId }, context).catch(() => undefined)
    throw new DOMException('Microphone admission was cancelled.', 'AbortError')
  }
  const record: SessionRecord = { lease: result.lease, context, cleanups: new Set(), revoked: false }
  sessions.set(result.lease.sessionId, record)
  let released = false
  const onAbort = (): void => {
    void admission.release()
  }
  const onDeviceChange = (): void => {
    if (options.onDeviceChange) options.onDeviceChange()
    else void admission.release()
  }
  const detachListeners = (): void => {
    signal?.removeEventListener('abort', onAbort)
    navigator.mediaDevices.removeEventListener?.('devicechange', onDeviceChange)
  }
  const admission: InputMicAdmission = {
    sessionId: result.lease.sessionId,
    get revoked() {
      return record.revoked
    },
    onRevoke(cleanup) {
      if (record.revoked) {
        cleanup()
        return () => {}
      }
      record.cleanups.add(cleanup)
      return () => record.cleanups.delete(cleanup)
    },
    async release() {
      if (released) return
      released = true
      for (const cleanup of [...record.cleanups]) {
        try {
          cleanup()
        } catch {
          /* best-effort teardown of associated renderer resources */
        }
      }
      record.cleanups.clear()
      sessions.delete(record.lease.sessionId)
      if (!record.revoked) {
        await window.toto.stopInputSession({ sessionId: record.lease.sessionId }, record.context).catch(() => undefined)
      }
    }
  }
  record.cleanups.add(detachListeners)
  try {
    signal?.addEventListener('abort', onAbort, { once: true })
    navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange)
    if (signal?.aborted) {
      await admission.release()
      throw new DOMException('Microphone admission was cancelled.', 'AbortError')
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    let mediaStopped = false
    const stopMedia = (): void => {
      if (mediaStopped) return
      mediaStopped = true
      try {
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch {
            /* continue stopping the rest of this owned stream */
          }
        }
      } catch {
        /* best-effort cleanup if stream track discovery itself fails */
      }
    }
    record.cleanups.add(stopMedia)
    if (released || record.revoked) {
      stopMedia()
      await admission.release()
      throw new Error('Microphone admission ended during capture startup.')
    }
    const confirmed = await window.toto.confirmInputSession(record.lease.sessionId, context).catch(() => false)
    if (released || record.revoked || !confirmed) {
      await admission.release()
      throw new Error('Microphone capture could not be confirmed by main.')
    }
    return { stream, admission, stopMedia }
  } catch (error) {
    await admission.release()
    throw error
  }
}

/** Meeting capture is admitted by the exact accepted live-meeting reservation in main. */
export async function acquireMeetingMic(
  constraints: MediaStreamConstraints,
  startedAt: number,
  signal?: AbortSignal
): Promise<{
  stream: MediaStream
  captureId: string
  revoked: boolean
  onRevoke(cleanup: Cleanup): () => void
  release(): Promise<void>
}> {
  if (signal?.aborted) throw new DOMException('Meeting microphone admission was cancelled.', 'AbortError')
  if (!meetingUnsubscribe) meetingUnsubscribe = window.toto.onMeetingMicCaptureRevoked(receiveMeetingRevocation)
  const grant = await window.toto.meetingMicAdmission(startedAt)
  if (!grant) throw new Error('Meeting microphone admission is unavailable.')
  if (signal?.aborted) {
    await window.toto.releaseMeetingMicCapture(grant.captureId).catch(() => false)
    throw new DOMException('Meeting microphone admission was cancelled.', 'AbortError')
  }
  const record: MeetingRecord = { startedAt, cleanups: new Set(), revoked: false }
  meetingCaptures.set(grant.captureId, record)
  let stream: MediaStream | null = null
  let released = false
  const onAbort = (): void => {
    void admission.release()
  }
  const detachListeners = (): void => signal?.removeEventListener('abort', onAbort)
  const admission = {
    captureId: grant.captureId,
    get revoked() {
      return record.revoked
    },
    onRevoke(cleanup: Cleanup) {
      if (record.revoked) {
        cleanup()
        return () => {}
      }
      record.cleanups.add(cleanup)
      return () => record.cleanups.delete(cleanup)
    },
    async release() {
      if (released) return
      released = true
      for (const cleanup of [...record.cleanups]) {
        try {
          cleanup()
        } catch {
          /* best-effort renderer teardown */
        }
      }
      record.cleanups.clear()
      meetingCaptures.delete(grant.captureId)
      if (!record.revoked) await window.toto.releaseMeetingMicCapture(grant.captureId).catch(() => false)
    }
  }
  record.cleanups.add(detachListeners)
  const onDeviceChange = (): void => {
    void admission.release()
  }
  const detachDeviceChange = (): void => navigator.mediaDevices.removeEventListener?.('devicechange', onDeviceChange)
  record.cleanups.add(detachDeviceChange)
  try {
    signal?.addEventListener('abort', onAbort, { once: true })
    navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange)
    if (signal?.aborted) {
      await admission.release()
      throw new DOMException('Meeting microphone admission was cancelled.', 'AbortError')
    }
    stream = await navigator.mediaDevices.getUserMedia(constraints)
    if (released || record.revoked) {
      stream.getTracks().forEach((track) => track.stop())
      await admission.release()
      throw new Error('Meeting microphone admission ended during capture startup.')
    }
    const ownedStream = stream
    record.cleanups.add(() => ownedStream.getTracks().forEach((track) => track.stop()))
    const confirmed = await window.toto.confirmMeetingMicCapture(grant.captureId, startedAt).catch(() => false)
    if (released || record.revoked || !confirmed) {
      await admission.release()
      throw new Error('Meeting microphone capture could not be confirmed by main.')
    }
    // Device changes revoke a grant while capture is starting; an established meeting stream
    // keeps its existing device until the meeting owner explicitly releases it.
    detachDeviceChange()
    record.cleanups.delete(detachDeviceChange)
    return {
      stream,
      captureId: grant.captureId,
      get revoked() {
        return record.revoked
      },
      onRevoke: admission.onRevoke,
      release: admission.release
    }
  } catch (error) {
    await admission.release()
    throw error
  }
}
