import { app } from 'electron'
import { METIS_PACKAGE_PROFILE } from '@shared/package-profile'
import { effectiveLocalSpeechPackPolicy, type LocalSpeechPackPolicy } from '@shared/model-policy'
import { getPublishedSettingsObservation } from './settings-observation'
import { registerHighTierAsrModelFetch } from './ipc/asr-model-download'
import { registerExplicitLocalModelEnsure } from './ipc/local-model-provisioning'
import {
  configureFreshLeanSpeechDefaults,
  getAdminLocalSpeechPackPolicy,
  getSettings,
  getSpeechPackPolicyIdentity,
  getSpeechPackSelectionIdentity,
  readSettingsAtAuthorityBoundary
} from './store'
import { asrModelMetadataReadyForEngine } from './asr-bundled-ensure'
import { getSpeechPolicyAuthorityStatus } from './model-policy-client'
import { speechPolicyIsConfigured } from './speech-policy-authority'
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
  ensureLocalModel: (
    modelId: string,
    authorized: () => Promise<boolean>,
    validateCurrent: () => boolean
  ) => Promise<boolean>
  captureActive: () => boolean
  captureIdentity: () => string
  localModelIdentity: () => string
  currentModelPolicyIdentity: () => string
  refreshScreenPreprocess: () => void
  logProvisioningFailure: (error: unknown) => void
  auditAsrTransfer: () => void
}): void {
  const packageRuntimeAvailable = async (): Promise<boolean> => {
    const contract = await getPackageRuntimeContract()
    return contract.status !== 'invalid' && contract.profile !== 'lean'
  }
  const readSettings = async () => {
    const authority = await readSettingsAtAuthorityBoundary()
    return {
      ...authority,
      modelPolicy: getSpeechPolicyAuthorityStatus(authority.settings)
    }
  }
  registerExplicitLocalModelEnsure({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    runtimeAvailable: packageRuntimeAvailable,
    captureActive: options.captureActive,
    captureIdentity: options.captureIdentity,
    localModelIdentity: options.localModelIdentity,
    currentModelPolicyIdentity: options.currentModelPolicyIdentity,
    readSettings,
    ensure: options.ensureLocalModel,
    onReady: options.refreshScreenPreprocess,
    onFailure: options.logProvisioningFailure
  })
  registerHighTierAsrModelFetch({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    authenticated: options.requireAuth,
    runtimeAvailable: packageRuntimeAvailable,
    authorityReadable: async () => {
      const authority = await readSettingsAtAuthorityBoundary()
      return (
        authority.readable &&
        resolveTrustedSpeechPackPolicy(authority.settings, authority.localSpeechPack) !== 'blocked'
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
      resolveTrustedSpeechPackPolicy(settings, getAdminLocalSpeechPackPolicy()) !== 'blocked'
    )
  }
  return startSpeechPackDesktop({
    ...options,
    selectedEngine: () => getSettings().asrEngine,
    selectionIdentity: getSpeechPackSelectionIdentity,
    policyAllowsTransfer,
    policyIdentity: () => {
      const settings = getSettings()
      return `${getSpeechPackPolicyIdentity()}:${getSpeechPolicyAuthorityStatus(settings).identity}`
    },
    refreshAuthority: async () => {
      const authority = await readSettingsAtAuthorityBoundary()
      return (
        authority.readable &&
        resolveTrustedSpeechPackPolicy(authority.settings, authority.localSpeechPack) !== 'blocked'
      )
    },
    refreshRollbackAuthority: async () => (await readSettingsAtAuthorityBoundary()).readable,
    rollbackAuthorityCurrent: () => {
      try {
        return getPublishedSettingsObservation()?.readable === true
      } catch {
        return false
      }
    },
    engineRuntimeReady: () =>
      options.verifiedPackageContract.status !== 'invalid' && options.verifiedPackageContract.profile !== 'lean',
    engineModelReady: (engine) => asrModelMetadataReadyForEngine(engine, options.verifiedPackageContract.profile)
  })
}

function resolveTrustedSpeechPackPolicy(
  settings: ReturnType<typeof getSettings>,
  localSpeechPack: ReturnType<typeof getAdminLocalSpeechPackPolicy>
): LocalSpeechPackPolicy {
  const authority = getSpeechPolicyAuthorityStatus(settings)
  if (authority.status === 'unverified') return 'blocked'
  if (
    authority.status === 'unconfigured' &&
    (speechPolicyIsConfigured(settings) ||
      settings.enterpriseLive?.managed !== false ||
      settings.enterpriseLive.inferenceMode !== 'legacy' ||
      settings.enterpriseLive.summaryOnly !== false)
  )
    return 'blocked'
  return effectiveLocalSpeechPackPolicy(authority.status === 'managed' ? authority.policy : null, localSpeechPack)
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
  refreshRollbackAuthority?: Parameters<typeof createSpeechPackService>[0]['refreshRollbackAuthority']
  rollbackAuthorityCurrent?: Parameters<typeof createSpeechPackService>[0]['rollbackAuthorityCurrent']
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
