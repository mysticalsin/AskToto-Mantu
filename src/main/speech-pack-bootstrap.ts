import { createSpeechPackService, registerSpeechPackIpc } from './features/components'
import { startSpeechPackPoll, waitForSpeechPackQuitFlush } from './infra/scheduler/speech-pack-poll'

export function startSpeechPackDesktop(options: {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  fixtureWavPath: string
  selectedEngine: () => 'whisper' | 'parakeet' | 'apple'
  policyAllowsTransfer: () => boolean
  captureActive: () => boolean
  ipcMain: Parameters<typeof registerSpeechPackIpc>[0]['ipcMain']
  assertMainWindow: Parameters<typeof registerSpeechPackIpc>[0]['assertMainWindow']
  sendProgress: Parameters<typeof registerSpeechPackIpc>[0]['sendProgress']
}) {
  const service = createSpeechPackService({
    ...options,
    policyAllowsTransfer: () => {
      try {
        return options.policyAllowsTransfer() === true
      } catch {
        return false
      }
    }
  })
  let closing: Promise<void> | null = null
  let quitPending = false
  let quitReady = false
  const refresh = (): void => {
    if (closing) return
    try {
      service.policyChanged()
      service.selectionChanged()
      service.captureActivityChanged(options.captureActive())
    } catch {
      // An unknown live authority must stop background work, never start or resume it.
      service.captureActivityChanged(true)
    }
  }
  refresh()
  const unregister = registerSpeechPackIpc({ ...options, service })
  const stopPoll = startSpeechPackPoll(refresh)
  const desktop = {
    refresh,
    shutdown(): Promise<void> {
      if (closing) return closing
      stopPoll()
      let cleanupFailed = false
      try {
        unregister()
      } catch {
        cleanupFailed = true
      }
      closing = service.shutdown()
      if (cleanupFailed)
        closing = closing.then(() => {
          throw new Error('Speech pack cleanup failed')
        })
      return closing
    },
    beforeQuit(event: { preventDefault(): void }, quit: () => void, meetingFlushPending = false): void {
      if (quitReady) return
      event.preventDefault()
      if (quitPending) return
      quitPending = true
      const resume = (): void => {
        quitReady = true
        quit()
      }
      void Promise.allSettled([
        desktop.shutdown(),
        meetingFlushPending ? waitForSpeechPackQuitFlush() : Promise.resolve()
      ]).then(resume)
    }
  }
  return desktop
}
