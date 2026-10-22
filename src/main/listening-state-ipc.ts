/** The small registration boundary that keeps the listening-stop IPC honest about native release. */
import { ListeningStatePayloadSchema, type ListeningStatePayload } from '@shared/ipc'
import { type MeetingStartAudit, recordMeetingStart } from './meeting-start-audit'

interface ListeningStateDependencies<Event> {
  assertMainWindow(event: Event): void
  requireAuth(): boolean
  /** Main owns the one authoritative identity. Rejected transitions must have no lifecycle effects. */
  acceptTransition(change: ListeningStatePayload, authorizeStart: () => boolean): boolean
  consumeMeetingStartActivation(event: Event): boolean
  setListeningActive(on: boolean): void
  setTrayRecording(on: boolean): void
  setRecordingPowerSaveBlock(on: boolean): void
  onMeetingStart(): void
  /** Content-free Start diagnostics (stage, outcome, reason code). Defaults to the audit-log recorder. */
  startAudit?: MeetingStartAudit
  releaseParakeet(): Promise<void>
  releaseSpeakerEmbedding(): Promise<unknown>
}

/** True when the raw payload asks to start listening (a bare `true`, or `{ on: true }`), however malformed the rest is. */
function isStartRequest(raw: unknown): boolean {
  return raw === true || (typeof raw === 'object' && raw !== null && (raw as { on?: unknown }).on === true)
}

/** Create the exact listening-state callback registered by index.ts over injectable side-effect seams. */
export function createListeningStateHandler<Event>(
  dependencies: ListeningStateDependencies<Event>
): (event: Event, rawOn: unknown) => Promise<boolean> {
  return async (event, rawOn) => {
    dependencies.assertMainWindow(event)
    const startAudit = dependencies.startAudit ?? recordMeetingStart
    if (!dependencies.requireAuth()) {
      if (isStartRequest(rawOn)) startAudit('transition', 'denied', 'not-authenticated')
      return false
    }
    const parsed = ListeningStatePayloadSchema.safeParse(typeof rawOn === 'boolean' ? { on: rawOn } : rawOn)
    if (!parsed.success) {
      if (isStartRequest(rawOn)) startAudit('transition', 'denied', 'invalid-request')
      return false
    }
    const grant: { state: 'not-asked' | 'consumed' | 'missing' } = { state: 'not-asked' }
    const accepted = dependencies.acceptTransition(parsed.data, () => {
      if (!parsed.data.on) return true
      const consumed = dependencies.consumeMeetingStartActivation(event)
      grant.state = consumed ? 'consumed' : 'missing'
      return consumed
    })
    if (!accepted) {
      if (parsed.data.on)
        startAudit(
          'transition',
          'denied',
          grant.state === 'missing'
            ? 'no-activation-grant'
            : grant.state === 'consumed'
              ? 'rejected-after-grant'
              : 'rejected-before-grant'
        )
      return false
    }
    const { on } = parsed.data
    dependencies.setListeningActive(on)
    dependencies.setTrayRecording(on)
    dependencies.setRecordingPowerSaveBlock(on)
    if (on) {
      startAudit('transition', 'accepted')
      dependencies.onMeetingStart()
      return true
    }
    // Both native helpers must get their teardown attempt even if one rejects. The handler stays pending
    // until both settle, then propagates the first failure so an unconfirmed exit is never reported clean.
    const releases = await Promise.allSettled([dependencies.releaseParakeet(), dependencies.releaseSpeakerEmbedding()])
    const failed = releases.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
    return true
  }
}
