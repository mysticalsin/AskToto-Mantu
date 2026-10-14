import { app } from 'electron'
import { METIS_PACKAGE_PROFILE } from '@shared/package-profile'
import {
  configurePackageRuntimeContractProvider,
  createPackageRuntimeContractProvider,
  createSpeechPackService
} from './features/components'
import { registerSpeechPackIpc } from './ipc/speech-pack-ipc'
import { startSpeechPackPoll, waitForSpeechPackQuitFlush } from './infra/scheduler/speech-pack-poll'
import type { QuitTrace } from './lifecycle/quit-trace'

export function startSpeechPackDesktop(options: {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  fixtureWavPath: string
  selectedEngine: () => 'whisper' | 'parakeet' | 'apple'
  selectionIdentity?: () => string
  policyAllowsTransfer: () => boolean
  policyIdentity?: () => string
  captureActive: () => boolean
  captureIdentity?: () => string
  packageRuntimeContract?: Parameters<typeof createSpeechPackService>[0]['packageRuntimeContract']
  engineModelReady?: Parameters<typeof createSpeechPackService>[0]['engineModelReady']
  engineRuntimeReady?: Parameters<typeof createSpeechPackService>[0]['engineRuntimeReady']
  ipcMain: Parameters<typeof registerSpeechPackIpc>[0]['ipcMain']
  assertMainWindow: Parameters<typeof registerSpeechPackIpc>[0]['assertMainWindow']
  sendProgress: Parameters<typeof registerSpeechPackIpc>[0]['sendProgress']
  quitTrace?: QuitTrace
}) {
  const packageRuntimeContract =
    options.packageRuntimeContract ??
    createPackageRuntimeContractProvider({
      resourcesRoot: options.resourcesRoot,
      compiledProfile: options.packaged ? METIS_PACKAGE_PROFILE : 'development',
      appVersion: app.getVersion()
    })
  configurePackageRuntimeContractProvider(packageRuntimeContract)
  // Package facts are read once at this explicit startup boundary and reused by status and runtime consumers.
  void packageRuntimeContract().catch(() => undefined)
  const service = createSpeechPackService({
    ...options,
    packageRuntimeContract,
    policyAllowsTransfer: () => {
      try {
        return options.policyAllowsTransfer() === true
      } catch {
        return false
      }
    },
    policyIdentity: options.policyIdentity
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
      if (options.quitTrace?.enabled) {
        options.quitTrace.mark('PACK_SHUTDOWN_START')
        options.quitTrace.mark(service.hasEngine() ? 'PACK_ENGINE_PRESENT' : 'PACK_ENGINE_NONE')
      }
      const serviceShutdown = service.shutdown()
      closing = serviceShutdown
      if (cleanupFailed)
        closing = closing.then(() => {
          throw new Error('Speech pack cleanup failed')
        })
      if (options.quitTrace?.enabled) {
        const trace = options.quitTrace
        const record = (phase: 'PACK_SHUTDOWN_SETTLED' | 'PACK_SHUTDOWN_REJECTED'): void => {
          try {
            trace.mark(phase)
          } catch {
            /* diagnostics must not alter the shutdown barrier */
          }
        }
        void closing.then(
          () => record('PACK_SHUTDOWN_SETTLED'),
          () => record('PACK_SHUTDOWN_REJECTED')
        )
      }
      return closing
    },
    beforeQuit(event: { preventDefault(): void }, quit: () => void, meetingFlushPending = false): void {
      if (quitReady) return
      event.preventDefault()
      if (quitPending) return
      quitPending = true
      const resume = (): void => {
        quitReady = true
        if (options.quitTrace?.enabled) {
          options.quitTrace.mark('PACK_QUIT_RESUME')
          options.quitTrace.call('PACK_RESUME', quit)
        } else {
          quit()
        }
      }
      void Promise.allSettled([
        desktop.shutdown(),
        meetingFlushPending ? waitForSpeechPackQuitFlush() : Promise.resolve()
      ]).then(resume)
    }
  }
  return desktop
}
