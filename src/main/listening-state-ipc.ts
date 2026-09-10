/** The small registration boundary that keeps the listening-stop IPC honest about native release. */

interface ListeningStateDependencies<Event> {
  assertMainWindow(event: Event): void
  requireAuth(): boolean
  setListeningActive(on: boolean): void
  setTrayRecording(on: boolean): void
  setRecordingPowerSaveBlock(on: boolean): void
  onMeetingStart(): void
  releaseParakeet(): Promise<void>
}

/** Create the exact listening-state callback registered by index.ts over injectable side-effect seams. */
export function createListeningStateHandler<Event>(
  dependencies: ListeningStateDependencies<Event>
): (event: Event, rawOn: unknown) => Promise<void> {
  return async (event, rawOn) => {
    dependencies.assertMainWindow(event)
    if (!dependencies.requireAuth()) return
    const on = !!rawOn
    dependencies.setListeningActive(on)
    dependencies.setTrayRecording(on)
    dependencies.setRecordingPowerSaveBlock(on)
    if (on) dependencies.onMeetingStart()
    else await dependencies.releaseParakeet()
  }
}
