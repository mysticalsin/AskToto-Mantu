import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { localModelAllowedByPolicy } from '@shared/model-policy'
import {
  getActiveModelPolicy,
  getSpeechPolicyAuthorityStatus,
  observeSpeechPolicyProofRevocations
} from './model-policy-client'
import {
  getPublishedSettingsObservation,
  getSettingsObservationEpoch,
  observeSettingsAuthorityChanges
} from './settings-observation'
import {
  getLocalModelProvisioningIdentity,
  getSpeechPackPolicyIdentity,
  getSpeechPackSelectionIdentity,
  readSettingsAtAuthorityBoundary
} from './store'
import { resolveTrustedSpeechPackPolicy } from './speech-pack-bootstrap'
import type { SpeechCaptureGrantRegistry } from './capture-permissions/speech-capture-grant'
import type { PackageRuntimeContract } from './features/components/speech-pack/package-contract'
import { getPackageRuntimeContract } from './features/components/speech-pack/package-runtime-state'
import { acquirePackageRuntimeLease } from './features/components/speech-pack/runtime-admission'
import {
  configureRuntimeLeaseProvider,
  initializeRuntimeHostEnvironment
} from './features/components/speech-pack/runtime-lease'
import { createRuntimeGenerationProvider } from './features/components/speech-pack/runtime-generation-provider'
import { createRuntimeInstallService } from './features/components/speech-pack/runtime-install-service'
import type { RuntimeInstallAuthoritySnapshot } from './features/components/speech-pack/runtime-install-plans'
import { runRuntimeCandidateSelfTest } from './features/components/speech-pack/runtime-candidate-self-test'
import { runtimeTargetFor } from './features/components/speech-pack/runtime-components'
import { createRuntimeWhisperHost } from './features/components/speech-pack/runtime-worker-host'
import { registerRuntimeInstallIpc } from './ipc/runtime-install-ipc'
import { registerRuntimeWhisperWorkerIpc } from './ipc/runtime-whisper-worker-ipc'

export function registerRuntimeConsumers(options: {
  readonly app: Pick<Electron.App, 'getPath' | 'getVersion' | 'on' | 'quit'>
  readonly ipcMain: Electron.IpcMain
  readonly assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  readonly resourcesRoot: string
  readonly packageContract: PackageRuntimeContract
  readonly captureActive: () => boolean
  readonly getWindow: () => Electron.BrowserWindow | null
  readonly grants: SpeechCaptureGrantRegistry
  readonly navigationEpoch: () => number
  readonly captureRevision: () => number
  readonly requireAuth: () => boolean
  readonly runBootWork: (name: string, work: () => Promise<unknown>) => void
  readonly warn: (message: string) => void
}) {
  const { app } = options
  const storeRoot = join(app.getPath('userData'), 'optional-runtimes')
  const provider = createRuntimeGenerationProvider({ resourcesRoot: options.resourcesRoot, storeRoot })
  configureRuntimeLeaseProvider(provider)
  options.runBootWork('validateRuntimeCatalog', async () => {
    await provider.initialize()
    await initializeRuntimeHostEnvironment()
  })
  const readAuthority = async (feature: 'offline-asr' | 'speaker-embedding' | 'local-llm') => {
    const authority = await readSettingsAtAuthorityBoundary()
    const settings = authority.settings
    const policy = getSpeechPolicyAuthorityStatus(settings)
    const selectedModelId =
      feature === 'offline-asr'
        ? settings.asrEngine === 'parakeet'
          ? 'asr.parakeet-tdt-0.6b-v3-int8'
          : settings.asrEngine === 'whisper'
            ? 'asr.whisper-base-q8'
            : null
        : feature === 'speaker-embedding'
          ? 'speaker.embedding'
          : settings.localLlm.modelId === 'qwen3.5-0.8b' || settings.localLlm.modelId === 'qwen3.5-4b'
            ? settings.localLlm.modelId
            : null
    const packageIdentity =
      options.packageContract.status === 'verified'
        ? `${options.packageContract.profile}:${options.packageContract.inventory.identity}`
        : `${options.packageContract.status}:${options.packageContract.profile}`
    const transferAllowed = resolveTrustedSpeechPackPolicy(settings, authority.localSpeechPack) !== 'blocked'
    const featureAllowed =
      feature === 'offline-asr'
        ? settings.asrEngine === 'whisper' || settings.asrEngine === 'parakeet'
        : feature === 'local-llm'
          ? selectedModelId !== null && localModelAllowedByPolicy(getActiveModelPolicy(settings), selectedModelId)
          : settings.speakerId.enabled === true
    const allowed =
      authority.readable &&
      options.requireAuth() &&
      options.packageContract.status === 'verified' &&
      options.packageContract.profile === 'lean' &&
      transferAllowed &&
      !options.captureActive() &&
      featureAllowed
    const profileIdentity = createHash('sha256').update(packageIdentity).digest('hex')
    const policyIdentity = createHash('sha256')
      .update(`${policy.identity}:${getSpeechPackPolicyIdentity()}:${authority.epoch}`)
      .digest('hex')
    const selection = feature === 'local-llm' ? getLocalModelProvisioningIdentity() : getSpeechPackSelectionIdentity()
    return {
      readable: authority.readable,
      allowedFeatures: allowed ? [feature] : [],
      profileIdentity,
      policyIdentity,
      selectionIdentity: createHash('sha256').update(selection).digest('hex'),
      captureIdentity: `capture:${options.captureRevision()}`,
      authorityEpoch: authority.epoch,
      captureActive: options.captureActive(),
      transferAllowed: allowed,
      selectedModelId
    } as const
  }
  const installService = createRuntimeInstallService({
    provider,
    resourcesRoot: options.resourcesRoot,
    storeRoot,
    readAuthority,
    readTarget: async () => runtimeTargetFor(await getPackageRuntimeContract(), app.getVersion()),
    selfTest: runRuntimeCandidateSelfTest
  })
  const installCleanup = registerRuntimeInstallIpc({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    assertAuthorityCurrent: (expected: RuntimeInstallAuthoritySnapshot, feature) => {
      const observation = getPublishedSettingsObservation()
      if (
        !observation?.readable ||
        observation.epoch !== expected.authorityEpoch ||
        getSettingsObservationEpoch() !== expected.authorityEpoch ||
        !options.requireAuth() ||
        options.captureActive() ||
        `capture:${options.captureRevision()}` !== expected.captureIdentity ||
        options.packageContract.status !== 'verified' ||
        options.packageContract.profile !== 'lean'
      ) {
        throw new Error('RUNTIME_INSTALL_PLAN_STALE')
      }
      const settings = observation.settings
      const selectedModelId =
        feature === 'offline-asr'
          ? settings.asrEngine === 'parakeet'
            ? 'asr.parakeet-tdt-0.6b-v3-int8'
            : settings.asrEngine === 'whisper'
              ? 'asr.whisper-base-q8'
              : null
          : feature === 'speaker-embedding'
            ? 'speaker.embedding'
            : settings.localLlm.modelId === 'qwen3.5-0.8b' || settings.localLlm.modelId === 'qwen3.5-4b'
              ? settings.localLlm.modelId
              : null
      const allowed =
        feature === 'offline-asr'
          ? selectedModelId !== null
          : feature === 'speaker-embedding'
            ? settings.speakerId.enabled === true
            : selectedModelId !== null && localModelAllowedByPolicy(getActiveModelPolicy(settings), selectedModelId)
      const selection = feature === 'local-llm' ? getLocalModelProvisioningIdentity() : getSpeechPackSelectionIdentity()
      const policy = getSpeechPolicyAuthorityStatus(settings)
      const packageIdentity = `${options.packageContract.profile}:${options.packageContract.inventory.identity}`
      if (
        !allowed ||
        !expected.allowedFeatures.includes(feature) ||
        expected.selectedModelId !== selectedModelId ||
        expected.profileIdentity !== createHash('sha256').update(packageIdentity).digest('hex') ||
        expected.selectionIdentity !== createHash('sha256').update(selection).digest('hex') ||
        expected.policyIdentity !==
          createHash('sha256')
            .update(`${policy.identity}:${getSpeechPackPolicyIdentity()}:${expected.authorityEpoch}`)
            .digest('hex')
      ) {
        throw new Error('RUNTIME_INSTALL_PLAN_STALE')
      }
    },
    plans: installService
  }).cleanup
  let stopAuthorityObservation = (): void => undefined
  let stopPolicyObservation = (): void => undefined
  const whisper = registerRuntimeWhisperWorkerIpc({
    ipcMain: options.ipcMain,
    assertMainWindow: options.assertMainWindow,
    readAuthority: async () => {
      const authority = await readSettingsAtAuthorityBoundary()
      const settings = authority.settings
      const policy = getSpeechPolicyAuthorityStatus(settings)
      const allowed =
        authority.readable &&
        options.requireAuth() &&
        options.packageContract.status === 'verified' &&
        options.packageContract.profile === 'lean' &&
        (settings.asrEngine === 'whisper' || settings.asrEngine === 'parakeet') &&
        policy.status !== 'unverified' &&
        resolveTrustedSpeechPackPolicy(settings, authority.localSpeechPack) !== 'blocked'
      const capture = options.grants.getAcceptedListenContext()
      const win = options.getWindow()
      const inputAllowed = Boolean(
        options.captureActive() &&
          win &&
          !win.isDestroyed() &&
          capture?.webContents === win.webContents &&
          capture.frame === win.webContents.mainFrame &&
          capture.navigationEpoch === options.navigationEpoch()
      )
      const identity = createHash('sha256')
        .update(
          `${authority.epoch}:${getSpeechPackSelectionIdentity()}:${policy.identity}:${options.packageContract.status}:${options.packageContract.profile}`
        )
        .digest('hex')
      return { readable: authority.readable, allowed, identity, inputAllowed }
    },
    acquireLease: async (signal) => {
      const lease = await acquirePackageRuntimeLease('offline-asr', undefined, signal)
      if (!lease) throw new Error('RUNTIME_NOT_CONFIGURED')
      return lease
    },
    createHost: createRuntimeWhisperHost
  })
  const consumers = {
    installService,
    installCleanup: () => {
      installCleanup()
      stopAuthorityObservation()
      stopPolicyObservation()
    },
    whisperCleanup: whisper.cleanup,
    revokeWhisper: whisper.revokeAll
  }
  const current = getPublishedSettingsObservation()
  const authorityKey = (settings: Settings): string => {
    const policy = getSpeechPolicyAuthorityStatus(settings)
    return `${settings.asrEngine}:${settings.speakerId.enabled}:${policy.identity}:${getSpeechPackPolicyIdentity()}`
  }
  let observedAuthority = current?.readable ? authorityKey(current.settings) : null
  stopAuthorityObservation = observeSettingsAuthorityChanges((observation) => {
    if (!observation.readable) {
      observedAuthority = null
      void consumers.revokeWhisper().catch((error: unknown) => options.warn(String(error)))
      return
    }
    const next = authorityKey(observation.settings)
    if (observedAuthority !== null && observedAuthority !== next) {
      void consumers.revokeWhisper().catch((error: unknown) => options.warn(String(error)))
    }
    observedAuthority = next
  })
  stopPolicyObservation = observeSpeechPolicyProofRevocations(() => {
    void consumers.revokeWhisper().catch((error: unknown) => options.warn(String(error)))
  })
  registerRuntimeConsumerShutdown(app, () => consumers, options.warn)
  return consumers
}

type RuntimeConsumerLifetime = ReturnType<typeof registerRuntimeConsumers>

export function registerRuntimeConsumerShutdown(
  app: Pick<Electron.App, 'on' | 'quit'>,
  current: () => RuntimeConsumerLifetime | null,
  warn: (message: string) => void
): void {
  let shuttingDown = false
  let shutdownComplete = false
  app.on('before-quit', (event) => {
    const consumers = current()
    if (shutdownComplete || !consumers) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    consumers.installCleanup()
    consumers.installService.clear()
    void consumers.whisperCleanup().then(
      () => {
        shutdownComplete = true
        app.quit()
      },
      () => {
        shuttingDown = false
        warn('Optional Whisper worker exit was not confirmed; its lease and host remain retained.')
      }
    )
  })
}

export function registerSpeechRuntimeSchemes(protocol: Pick<Electron.Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'asr-model',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    },
    {
      // The UI's default Session never receives this handler; the private host Session remains CSP-bound.
      scheme: 'metis-runtime',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}
