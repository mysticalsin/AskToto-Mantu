/** The small registration boundary that keeps the listening-stop IPC honest about native release. */
import { ListeningStatePayloadSchema, type ListeningStatePayload } from '@shared/ipc'

interface ListeningStateDependencies<Event> {
  assertMainWindow(event: Event): void
  requireAuth(): boolean
  /** Main owns the one authoritative identity. Rejected transitions must have no lifecycle effects. */
  acceptTransition(change: ListeningStatePayload): boolean
  setListeningActive(on: boolean): void
  setTrayRecording(on: boolean): void
  setRecordingPowerSaveBlock(on: boolean): void
  onMeetingStart(): void
  releaseParakeet(): Promise<void>
  releaseSpeakerEmbedding(): Promise<unknown>
}

/** Create the exact listening-state callback registered by index.ts over injectable side-effect seams. */
export function createListeningStateHandler<Event>(
  dependencies: ListeningStateDependencies<Event>
): (event: Event, rawOn: unknown) => Promise<void> {
  return async (event, rawOn) => {
    dependencies.assertMainWindow(event)
    if (!dependencies.requireAuth()) return
    const parsed = ListeningStatePayloadSchema.safeParse(typeof rawOn === 'boolean' ? { on: rawOn } : rawOn)
    if (!parsed.success || !dependencies.acceptTransition(parsed.data)) return
    const { on } = parsed.data
    dependencies.setListeningActive(on)
    dependencies.setTrayRecording(on)
    dependencies.setRecordingPowerSaveBlock(on)
    if (on) {
      dependencies.onMeetingStart()
      return
    }
    // Both native helpers must get their teardown attempt even if one rejects. The handler stays pending
    // until both settle, then propagates the first failure so an unconfirmed exit is never reported clean.
    const releases = await Promise.allSettled([
      dependencies.releaseParakeet(),
      dependencies.releaseSpeakerEmbedding()
    ])
    const failed = releases.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
