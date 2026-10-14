import { app } from 'electron'
import { IPC } from '@shared/ipc'
import { METIS_PACKAGE_PROFILE } from '@shared/package-profile'
import { getPublishedSettingsObservation } from './settings-observation'
import {
  configureFreshLeanSpeechDefaults,
  getAllowedProviders,
  getAdminLocalSpeechPackPolicy,
  getSettings,
  getSpeechPackPolicyIdentity,
  getSpeechPackSelectionIdentity,
  readSettingsAtAuthorityBoundary
} from './store'
import { asrModelMetadataReadyForEngine } from './asr-bundled-ensure'
import { registerExplicitLocalModelEnsure } from './local-model-provisioning'
import { registerHighTierAsrModelFetch } from './asr-model-download'
import { resolveLocalSpeechPackPolicy } from './model-policy-client'
import { getPackageRuntimeContract } from './features/components/speech-pack/package-runtime-state'
import {
  configurePackageRuntimeContractProvider,
  createPackageRuntimeContractProvider,
  createSpeechPackService
} from './features/components'
import { registerSpeechPackIpc } from './ipc/speech-pack-ipc'
import { startSpeechPackPoll, waitForSpeechPackQuitFlush } from './infra/scheduler/speech-pack-poll'

export function registerOptionalModelProvisioningIpc(options: {
  ipcMain: Electron.IpcMain
  assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  ensureLocalModel: (modelId: string) => Promise<boolean>
  refreshScreenPreprocess: () => void
  logProvisioningFailure: (error: unknown) => void
  auditAsrTransfer: () => void
}): void {
  const packageRuntimeAvailable = async (): Promise<boolean> => {
    const contract = await getPackageRuntimeContract()
    return contract.status !== 'invalid' && contract.profile !== 'lean'
  }
  const readSettings = () => {
    const settings = readSettingsAtAuthorityBoundary()
    const allowed = getAllowedProviders()
    return {
      settings,
      readable: getPublishedSettingsObservation()?.readable === true && (!allowed || allowed.includes('local'))
    }
  }
  registerExplicitLocalModelEnsure({
    ipcMain: options.ipcMain,
    channel: IPC.localModelsEnsure,
    assertMainWindow: options.assertMainWindow,
    runtimeAvailable: packageRuntimeAvailable,
    readSettings,
    allowedProviders: getAllowedProviders,
    ensure: options.ensureLocalModel,
    onReady: options.refreshScreenPreprocess,
    onFailure: options.logProvisioningFailure
  })
  registerHighTierAsrModelFetch({
    ipcMain: options.ipcMain,
    channel: IPC.asrModelFetch,
    assertMainWindow: options.assertMainWindow,
    authenticated: options.requireAuth,
    runtimeAvailable: packageRuntimeAvailable,
    authorityReadable: () => {
      const settings = readSettingsAtAuthorityBoundary()
      return (
        getPublishedSettingsObservation()?.readable === true &&
        resolveLocalSpeechPackPolicy(settings, getAdminLocalSpeechPackPolicy()) !== 'blocked'
      )
    },
    onTransfer: options.auditAsrTransfer
  })
}

export async function prepareSpeechPackRuntime(resourcesRoot: string, packaged: boolean) {
  const packageRuntimeContract = createPackageRuntimeContractProvider({
    resourcesRoot,
    compiledProfile: packaged ? METIS_PACKAGE_PROFILE : 'development',
    appVersion: app.getVersion()
  })
  configurePackageRuntimeContractProvider(packageRuntimeContract)
  const verifiedPackageContract = await packageRuntimeContract()
  await configureFreshLeanSpeechDefaults(packaged ? METIS_PACKAGE_PROFILE : 'full', verifiedPackageContract)
  return { packageRuntimeContract, verifiedPackageContract }
}

export function startSpeechPackDesktopFromMain(options: {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  fixtureWavPath: string
  packageRuntimeContract: Parameters<typeof createSpeechPackService>[0]['packageRuntimeContract']
  verifiedPackageContract: Awaited<
    ReturnType<NonNullable<Parameters<typeof createSpeechPackService>[0]['packageRuntimeContract']>>
  >
  captureActive: () => boolean
  captureIdentity: () => string
  ipcMain: Parameters<typeof registerSpeechPackIpc>[0]['ipcMain']
  assertMainWindow: Parameters<typeof registerSpeechPackIpc>[0]['assertMainWindow']
  sendProgress: Parameters<typeof registerSpeechPackIpc>[0]['sendProgress']
}) {
  const policyAllowsTransfer = (): boolean => {
    const settings = getSettings()
    return (
      getPublishedSettingsObservation()?.readable === true &&
      resolveLocalSpeechPackPolicy(settings, getAdminLocalSpeechPackPolicy()) !== 'blocked'
    )
  }
  return startSpeechPackDesktop({
    ...options,
    selectedEngine: () => getSettings().asrEngine,
    selectionIdentity: getSpeechPackSelectionIdentity,
    policyAllowsTransfer,
    policyIdentity: getSpeechPackPolicyIdentity,
    refreshAuthority: () => {
      const settings = readSettingsAtAuthorityBoundary()
      return (
        getPublishedSettingsObservation()?.readable === true &&
        resolveLocalSpeechPackPolicy(settings, getAdminLocalSpeechPackPolicy()) !== 'blocked'
      )
    },
    engineRuntimeReady: () =>
      options.verifiedPackageContract.status !== 'invalid' && options.verifiedPackageContract.profile !== 'lean',
    engineModelReady: (engine) => asrModelMetadataReadyForEngine(engine, options.verifiedPackageContract.profile)
  })
}

export function startSpeechPackDesktop(options: {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  fixtureWavPath: string
  selectedEngine: () => 'whisper' | 'parakeet' | 'apple'
  selectionIdentity?: () => string
  policyAllowsTransfer: () => boolean
  policyIdentity?: () => string
  refreshAuthority?: Parameters<typeof createSpeechPackService>[0]['refreshAuthority']
  captureActive: () => boolean
  captureIdentity?: () => string
  packageRuntimeContract?: Parameters<typeof createSpeechPackService>[0]['packageRuntimeContract']
  engineModelReady?: Parameters<typeof createSpeechPackService>[0]['engineModelReady']
  engineRuntimeReady?: Parameters<typeof createSpeechPackService>[0]['engineRuntimeReady']
  ipcMain: Parameters<typeof registerSpeechPackIpc>[0]['ipcMain']
  assertMainWindow: Parameters<typeof registerSpeechPackIpc>[0]['assertMainWindow']
  sendProgress: Parameters<typeof registerSpeechPackIpc>[0]['sendProgress']
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
