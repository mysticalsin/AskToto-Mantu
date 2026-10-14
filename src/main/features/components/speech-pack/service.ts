import { randomUUID } from 'node:crypto'
import {
  SpeechPackActionRequestSchema,
  SpeechPackActionResultSchema,
  SpeechPackInstallWithPlanRequestSchema,
  SpeechPackPlanPreviewRequestSchema,
  SpeechPackPlanPreviewResultSchema,
  SpeechPackProgressSchema,
  SpeechPackSnapshotSchema,
  type SpeechPackActionRequest,
  type SpeechPackActionResult,
  type SpeechPackComponentSnapshot,
  type SpeechPackInstallWithPlanRequest,
  type SpeechPackPlanPreviewResult,
  type SpeechPackProgress,
  type SpeechPackSnapshot
} from '@shared/speech-pack'
import type { SpeechPackEngine, SpeechPackState } from './engine'
import { createSpeechPackEngine } from './engine'
import { speechPackEnabled } from './flag'
import {
  PARAKEET_TDT_V3_INT8,
  SPEECH_PACK_COMPONENTS,
  SELF_TEST_FIXTURE,
  WHISPER_BASE_Q8,
  componentBytes,
  componentDownloadBytes,
  isImmutableUrl,
  type SpeechPackComponent,
  type SpeechPackComponentId
} from './manifest'
import { componentManifestIdentity, resolveSpeechPack } from './resolver'
import { runSpeechPackSelfTest } from './self-test'
import type { PackageRuntimeContract } from './package-contract'
import { resolveOptionalRuntimeReadiness, runtimeIdsForEngine, runtimeIdsForLocalLlm } from './runtime-components'

export interface SpeechPackServiceOptions {
  resourcesRoot: string
  packaged: boolean
  rootDir: string
  selectedEngine: () => 'whisper' | 'parakeet' | 'apple'
  /** Stable opaque identity of the selected engine setting, including away-and-back transitions. */
  selectionIdentity?: () => string
  policyAllowsTransfer: () => boolean
  /** Stable opaque identity for the effective policy; changes invalidate a reviewed plan. */
  policyIdentity?: () => string
  /** Force current managed/admin trust only at explicit admission and activation boundaries. */
  refreshAuthority?: () => boolean | Promise<boolean>
  /** Fresh trust read for restoration-only renames after an interrupted/revoked activation. */
  refreshRollbackAuthority?: () => boolean | Promise<boolean>
  /** Live authoritative capture state; a throwing getter fails closed. */
  captureActive?: () => boolean
  /** Stable capture epoch identity, including a capture that starts and ends between status polls. */
  captureIdentity?: () => string
  featureEnabled?: () => boolean
  fixtureWavPath: string
  createEngine?: (options: Parameters<typeof createSpeechPackEngine>[0]) => SpeechPackEngine
  components?: readonly SpeechPackComponent[]
  /** Loaded once at the explicit app startup boundary; immutable for this app process. */
  packageRuntimeContract?: () => Promise<PackageRuntimeContract>
  /** Full/development packages keep the established bundled runtime path; lean needs an activated runtime pack. */
  engineRuntimeReady?: (engine: 'whisper' | 'parakeet' | 'apple') => boolean | Promise<boolean>
  /** Existing packaged model readiness, separate from a userData speech-pack activation. */
  engineModelReady?: (engine: 'whisper' | 'parakeet' | 'apple') => boolean | Promise<boolean>
  shutdownTimeoutMs?: number
}

interface InstallPlanRecord {
  plan: Extract<SpeechPackPlanPreviewResult, { ok: true }>['plan']
  authorityRevision: number
  selectedEngine: 'whisper' | 'parakeet' | 'apple'
  packageStatus: PackageRuntimeContract['status']
  policyIdentity: string
  selectionIdentity: string
  captureIdentity: string
  expiresAt: number
}

const INSTALL_PLAN_TTL_MS = 10 * 60 * 1000

function selectedId(engine: 'whisper' | 'parakeet' | 'apple'): SpeechPackComponentId | null {
  return engine === 'whisper' ? WHISPER_BASE_Q8.id : engine === 'parakeet' ? PARAKEET_TDT_V3_INT8.id : null
}

function finiteState(state: SpeechPackState): SpeechPackProgress['state'] {
  return state.status === 'not-installed' ? 'paused' : state.status === 'error' ? 'error' : state.status
}

function sourceHost(component: SpeechPackComponent): string | null {
  const url = component.source.kind === 'files' ? component.source.baseUrl : component.source.archive?.url
  if (!url || !isImmutableUrl(url)) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname ? parsed.hostname : null
  } catch {
    return null
  }
}

/** Explicit-consent-only service. Status is cheap and never creates the engine or touches the network. */
export function createSpeechPackService(options: SpeechPackServiceOptions) {
  const components = options.components ?? SPEECH_PACK_COMPONENTS
  const byId = new Map(components.map((component) => [component.id, component]))
  const createEngine = options.createEngine ?? createSpeechPackEngine
  const featureEnabled = options.featureEnabled ?? (() => speechPackEnabled())
  let engine: SpeechPackEngine | null = null
  let unsubscribe: (() => void) | null = null
  let currentProgress: SpeechPackProgress | null = null
  const activity = new Set<SpeechPackComponentId>()
  const activeAuthority = new Map<
    SpeechPackComponentId,
    { policyIdentity: string; selectionIdentity: string; captureIdentity: string }
  >()
  const pendingAdmissions = new Map<SpeechPackComponentId, symbol>()
  let authorityRevision = 0
  let captureActive = false
  let closing = false
  let observedSelection: 'whisper' | 'parakeet' | 'apple' = options.selectedEngine()

  const policyAllows = (): boolean => {
    try {
      return options.policyAllowsTransfer() === true
    } catch {
      return false
    }
  }
  const listeners = new Set<(progress: SpeechPackProgress) => void>()
  const repairVerified = new Set<SpeechPackComponentId>()
  const resumeScope = randomUUID()
  const installPlans = new Map<string, InstallPlanRecord>()
  let packageContractPromise: Promise<PackageRuntimeContract> | null = null

  const currentPolicyIdentity = (): string | null => {
    try {
      const identity = options.policyIdentity?.() ?? (policyAllows() ? 'allowed' : 'blocked')
      return typeof identity === 'string' && identity.length > 0 && identity.length <= 256 ? identity : null
    } catch {
      return null
    }
  }

  const currentSelectionIdentity = (): string | null => {
    try {
      const identity = options.selectionIdentity?.() ?? options.selectedEngine()
      return typeof identity === 'string' && identity.length > 0 && identity.length <= 256 ? identity : null
    } catch {
      return null
    }
  }

  const currentCaptureIdentity = (): string | null => {
    try {
      const identity = options.captureIdentity?.() ?? (isCaptureActive() ? null : 'inactive')
      return typeof identity === 'string' && identity.length > 0 && identity.length <= 256 ? identity : null
    } catch {
      return null
    }
  }
  const refreshAuthority = async (): Promise<boolean> => {
    try {
      return (await options.refreshAuthority?.()) !== false
    } catch {
      return false
    }
  }
  const refreshRollbackAuthority = async (): Promise<boolean> => {
    try {
      return (await options.refreshRollbackAuthority?.()) !== false
    } catch {
      return false
    }
  }
  let observedSelectionIdentity = currentSelectionIdentity()
  let observedPolicyIdentity = currentPolicyIdentity()

  const isCaptureActive = (): boolean => {
    if (captureActive) return true
    try {
      return options.captureActive?.() ?? false
    } catch {
      return true
    }
  }

  const getEngine = (): SpeechPackEngine => {
    if (engine) return engine
    engine = createEngine({
      rootDir: options.rootDir,
      fixtureWavPath: options.fixtureWavPath,
      fixture: SELF_TEST_FIXTURE,
      selfTest: runSpeechPackSelfTest,
      components,
      resumeScope,
      authorizeTransfer: (id) => {
        const authority = activeAuthority.get(id)
        return Boolean(
          authority &&
            activity.has(id) &&
            policyAllows() &&
            currentPolicyIdentity() === authority.policyIdentity &&
            !isCaptureActive() &&
            currentCaptureIdentity() === authority.captureIdentity &&
            selectedId(options.selectedEngine()) === id &&
            currentSelectionIdentity() === authority.selectionIdentity
        )
      },
      authorizeActivation: async (id) => {
        if (!(await refreshAuthority())) return false
        const authority = activeAuthority.get(id)
        return Boolean(
          authority &&
            activity.has(id) &&
            policyAllows() &&
            currentPolicyIdentity() === authority.policyIdentity &&
            !isCaptureActive() &&
            currentCaptureIdentity() === authority.captureIdentity &&
            selectedId(options.selectedEngine()) === id &&
            currentSelectionIdentity() === authority.selectionIdentity
        )
      },
      authorizeRollback: refreshRollbackAuthority
    })
    unsubscribe = engine.subscribe(({ id, state, freshlyVerified }) => {
      const manifestIdentity = componentManifestIdentity(byId.get(id) as SpeechPackComponent)
      const progress: SpeechPackProgress =
        state.status === 'downloading'
          ? {
              componentId: id,
              manifestIdentity,
              bytesDone: Math.min(state.bytesDone, state.bytesTotal),
              bytesTotal: state.bytesTotal,
              state: 'downloading'
            }
          : {
              componentId: id,
              manifestIdentity,
              bytesDone: 0,
              bytesTotal: componentBytes(byId.get(id) as SpeechPackComponent),
              state: finiteState(state)
            }
      currentProgress = progress
      const validatedProgress = SpeechPackProgressSchema.parse(progress)
      for (const listener of listeners) listener(validatedProgress)
      if (state.status === 'ready') {
        if (freshlyVerified) repairVerified.add(id)
        else repairVerified.delete(id)
      }
      if (state.status === 'error' || state.status === 'paused') {
        repairVerified.delete(id)
      }
      if (state.status === 'ready' || state.status === 'error' || state.status === 'paused') {
        activity.delete(id)
        activeAuthority.delete(id)
      }
    })
    return engine
  }

  const snapshot = async (): Promise<SpeechPackSnapshot> => {
    const packageContract = await currentPackageContract()
    const profile = packageContract.profile
    const rows = await Promise.all(
      components.map(async (component): Promise<SpeechPackComponentSnapshot> => {
        const resolved = await resolveSpeechPack(options.rootDir, component)
        if (resolved.status !== 'ready') repairVerified.delete(component.id)
        const state = engine?.getState(component.id)
        const transient = state && state.status !== 'not-installed' && state.status !== 'ready'
        return {
          componentId: component.id,
          manifestIdentity: componentManifestIdentity(component),
          version: component.version,
          state: sourceHost(component) === null ? 'not-configured' : transient ? finiteState(state) : resolved.status,
          downloadBytes: componentDownloadBytes(component),
          installedBytes: component.files.reduce((sum, file) => sum + file.bytes, 0),
          sourceHost: sourceHost(component),
          integrity: repairVerified.has(component.id) ? 'freshly-hash-verified-and-self-tested' : resolved.evidence,
          ...(state?.status === 'error' && state.requiredBytes !== undefined
            ? { requiredBytes: state.requiredBytes }
            : {}),
          ...(state?.status === 'error' && state.freeBytes !== undefined ? { freeBytes: state.freeBytes } : {})
        }
      })
    )
    // Read selection only after metadata I/O so a slow result cannot pair old engine state with new progress.
    const selectedEngine = options.selectedEngine()
    const selectedIdentity = options.selectionIdentity?.() ?? selectedEngine
    const selectedComponent = selectedId(selectedEngine)
    const selectedRow = selectedComponent ? rows.find((row) => row.componentId === selectedComponent) : undefined
    const runtimeComponentIds = runtimeIdsForEngine(selectedEngine)
    const runtimeComponentId = runtimeComponentIds[0]
    const runtimeReadiness = runtimeComponentId
      ? resolveOptionalRuntimeReadiness(runtimeComponentId, packageContract)
      : 'ready'
    let engineState:
      | 'ready'
      | 'model-needed'
      | 'runtime-needed'
      | 'not-configured'
      | 'incompatible'
      | 'repair-needed'
      | 'unavailable'
    if (selectedEngine === 'apple') {
      engineState = process.platform === 'darwin' ? 'ready' : 'unavailable'
    } else if (packageContract.status === 'invalid') {
      engineState = 'incompatible'
    } else if (runtimeReadiness === 'incompatible') {
      engineState = 'incompatible'
    } else if (runtimeReadiness === 'not-configured') {
      engineState = 'not-configured'
    } else if (options.engineRuntimeReady) {
      try {
        if (!(await options.engineRuntimeReady(selectedEngine))) {
          engineState = 'runtime-needed'
        } else if (options.engineModelReady) {
          engineState = (await options.engineModelReady(selectedEngine)) ? 'ready' : 'model-needed'
        } else if (selectedRow?.state === 'repair-needed') {
          engineState = 'repair-needed'
        } else if (selectedRow?.state === 'ready') {
          engineState = 'ready'
        } else {
          engineState = 'model-needed'
        }
      } catch {
        engineState = 'runtime-needed'
      }
    } else if (options.engineModelReady) {
      try {
        engineState = (await options.engineModelReady(selectedEngine)) ? 'ready' : 'model-needed'
      } catch {
        engineState = 'model-needed'
      }
    } else if (selectedRow?.state === 'repair-needed') {
      engineState = 'repair-needed'
    } else if (selectedRow?.state === 'ready') {
      engineState = 'ready'
    } else {
      engineState = 'model-needed'
    }
    if (selectedIdentity !== (options.selectionIdentity?.() ?? options.selectedEngine())) engineState = 'unavailable'
    return SpeechPackSnapshotSchema.parse({
      featureEnabled: featureEnabled(),
      profile,
      profileError: packageContract.status === 'invalid' ? 'invalid-profile' : null,
      selectedEngine,
      selectedComponent,
      packageProfile: {
        status: packageContract.status,
        profile,
        identity: packageContract.status === 'verified' ? packageContract.inventory.identity : null,
        platform: packageContract.status === 'verified' ? packageContract.inventory.platform : null,
        arch: packageContract.status === 'verified' ? packageContract.inventory.arch : null,
        reason: packageContract.status === 'invalid' ? packageContract.reason : null
      },
      engineReadiness: {
        engine: selectedEngine,
        state: engineState,
        modelComponentId: selectedComponent,
        runtimeComponentIds
      },
      optionalRuntimeReadiness: {
        speakerEmbedding: resolveOptionalRuntimeReadiness('runtime.speaker-embedding', packageContract),
        localLlm: resolveOptionalRuntimeReadiness(runtimeIdsForLocalLlm()[0], packageContract)
      },
      components: rows,
      progress: currentProgress
    })
  }

  async function currentPackageContract(): Promise<PackageRuntimeContract> {
    if (packageContractPromise === null) {
      packageContractPromise = (async (): Promise<PackageRuntimeContract> => {
        if (options.packageRuntimeContract) return options.packageRuntimeContract()
        if (!options.packaged) return { status: 'development', profile: 'development', inventory: null }
        return {
          status: 'invalid',
          reason: 'inventory-invalid',
          profile: null,
          inventory: null
        }
      })().catch(
        (): PackageRuntimeContract => ({
          status: 'invalid',
          reason: 'inventory-invalid',
          profile: null,
          inventory: null
        })
      )
    }
    return packageContractPromise
  }

  const planPreview = async (value: unknown): Promise<SpeechPackPlanPreviewResult> => {
    const parsed = SpeechPackPlanPreviewRequestSchema.safeParse(value)
    if (!parsed.success) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'invalid-request' })
    const request = parsed.data
    const component = byId.get(request.componentId)
    if (!component) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'invalid-request' })
    if (componentManifestIdentity(component) !== request.manifestIdentity)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'stale-manifest' })
    if (sourceHost(component) === null)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'not-configured' })
    if (!(await refreshAuthority()))
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (closing) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'busy' })
    if (!featureEnabled()) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'disabled' })
    const initiallySelectedEngine = options.selectedEngine()
    if (selectedId(initiallySelectedEngine) !== component.id) {
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'not-selected' })
    }
    if (!policyAllows()) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    const policyIdentity = currentPolicyIdentity()
    if (policyIdentity === null) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (isCaptureActive()) return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'busy' })
    const selectionIdentity = currentSelectionIdentity()
    const captureIdentity = currentCaptureIdentity()
    if (selectionIdentity === null || captureIdentity === null)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'stale-plan' })
    const revision = authorityRevision
    const selectedEngine = initiallySelectedEngine
    const packageContract = await currentPackageContract()
    if (
      revision !== authorityRevision ||
      closing ||
      !featureEnabled() ||
      selectedId(options.selectedEngine()) !== component.id ||
      currentPolicyIdentity() !== policyIdentity ||
      currentSelectionIdentity() !== selectionIdentity ||
      currentCaptureIdentity() !== captureIdentity
    ) {
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'stale-plan' })
    }
    if (packageContract.status === 'invalid') {
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'profile-invalid' })
    }
    if (packageContract.status === 'verified' && packageContract.profile === 'lean') {
      // A model pack by itself cannot make an engine usable; its reviewed runtime artifact is unavailable.
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'not-configured' })
    }
    if (!policyAllows() || currentPolicyIdentity() !== policyIdentity)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (isCaptureActive() || currentCaptureIdentity() !== captureIdentity)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'busy' })
    const readiness = await resolveSpeechPack(options.rootDir, component)
    if (
      revision !== authorityRevision ||
      selectedId(options.selectedEngine()) !== component.id ||
      currentSelectionIdentity() !== selectionIdentity ||
      currentCaptureIdentity() !== captureIdentity
    ) {
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'stale-plan' })
    }
    if (!policyAllows() || currentPolicyIdentity() !== policyIdentity)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (isCaptureActive() || currentCaptureIdentity() !== captureIdentity)
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'busy' })
    if (request.action === 'install' && readiness.status === 'ready') {
      return SpeechPackPlanPreviewResultSchema.parse({ ok: false, reason: 'unavailable' })
    }
    const planId = randomUUID()
    const profile = packageContract.profile
    const profileIdentity = packageContract.status === 'verified' ? packageContract.inventory.identity : null
    const bytes = componentBytes(component)
    const plan = SpeechPackPlanPreviewResultSchema.parse({
      ok: true,
      plan: {
        planId,
        action: request.action,
        feature: 'asr',
        selectedComponent: component.id,
        missingComponents: [
          {
            componentId: component.id,
            manifestIdentity: request.manifestIdentity,
            downloadBytes: componentDownloadBytes(component),
            storageBytes: bytes,
            // A runtime transfer plan cannot be shown until the artifact's license has been reviewed.
            license: null,
            sourceHost: sourceHost(component)
          }
        ],
        totalDownloadBytes: componentDownloadBytes(component),
        totalStorageBytes: bytes,
        profile,
        profileIdentity
      }
    })
    const parsedPlan = (plan as Extract<SpeechPackPlanPreviewResult, { ok: true }>).plan
    installPlans.set(planId, {
      plan: parsedPlan,
      authorityRevision,
      selectedEngine,
      packageStatus: packageContract.status,
      policyIdentity,
      selectionIdentity,
      captureIdentity,
      expiresAt: Date.now() + INSTALL_PLAN_TTL_MS
    })
    for (const [id, item] of installPlans) if (item.expiresAt <= Date.now()) installPlans.delete(id)
    while (installPlans.size > 32) installPlans.delete(installPlans.keys().next().value as string)
    return plan
  }

  const installWithPlan = async (value: SpeechPackInstallWithPlanRequest): Promise<SpeechPackActionResult> => {
    const parsed = SpeechPackInstallWithPlanRequestSchema.safeParse(value)
    if (!parsed.success) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'invalid-request' })
    const request: SpeechPackInstallWithPlanRequest = parsed.data
    const record = installPlans.get(request.planId)
    // Plans are single-use even if a later authorization check denies execution.
    installPlans.delete(request.planId)
    if (!record || record.expiresAt <= Date.now())
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'plan-expired' })
    if (!(await refreshAuthority())) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (record.authorityRevision !== authorityRevision || request.action !== record.plan.action)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    if (closing || !featureEnabled()) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'disabled' })
    const component = byId.get(record.plan.selectedComponent)
    if (!component || componentManifestIdentity(component) !== record.plan.missingComponents[0]?.manifestIdentity)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-manifest' })
    if (sourceHost(component) === null)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'not-configured' })
    if (selectedId(options.selectedEngine()) !== component.id || options.selectedEngine() !== record.selectedEngine)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'not-selected' })
    if (!policyAllows() || currentPolicyIdentity() !== record.policyIdentity)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (
      isCaptureActive() ||
      currentCaptureIdentity() !== record.captureIdentity ||
      currentSelectionIdentity() !== record.selectionIdentity
    )
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'busy' })
    const packageContract = await currentPackageContract()
    if (closing || !featureEnabled()) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'disabled' })
    if (packageContract.status === 'invalid' || packageContract.status !== record.packageStatus) {
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'profile-invalid' })
    }
    const profileIdentity = packageContract.status === 'verified' ? packageContract.inventory.identity : null
    if (
      packageContract.profile !== record.plan.profile ||
      profileIdentity !== record.plan.profileIdentity ||
      (packageContract.status === 'verified' && packageContract.profile === 'lean')
    ) {
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    }
    if (
      selectedId(options.selectedEngine()) !== component.id ||
      record.authorityRevision !== authorityRevision ||
      currentSelectionIdentity() !== record.selectionIdentity ||
      currentCaptureIdentity() !== record.captureIdentity
    ) {
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    }
    if (!policyAllows() || currentPolicyIdentity() !== record.policyIdentity)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (
      isCaptureActive() ||
      currentCaptureIdentity() !== record.captureIdentity ||
      currentSelectionIdentity() !== record.selectionIdentity
    )
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'busy' })
    // Consent expires if the model state changes before transfer admission.
    const readiness = await resolveSpeechPack(options.rootDir, component)
    if (closing || !featureEnabled()) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'disabled' })
    if (
      record.authorityRevision !== authorityRevision ||
      selectedId(options.selectedEngine()) !== component.id ||
      currentSelectionIdentity() !== record.selectionIdentity ||
      currentCaptureIdentity() !== record.captureIdentity
    )
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    if (!policyAllows() || currentPolicyIdentity() !== record.policyIdentity)
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (isCaptureActive()) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'busy' })
    if (request.action === 'install' && readiness.status === 'ready')
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    if (pendingAdmissions.has(component.id) || activity.has(component.id)) {
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'busy' })
    }
    if (!(await refreshAuthority())) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'policy-blocked' })
    if (
      record.authorityRevision !== authorityRevision ||
      selectedId(options.selectedEngine()) !== component.id ||
      currentPolicyIdentity() !== record.policyIdentity ||
      currentSelectionIdentity() !== record.selectionIdentity ||
      currentCaptureIdentity() !== record.captureIdentity ||
      isCaptureActive()
    )
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'stale-plan' })
    const instance = getEngine()
    const state = instance.getState(component.id)
    if (
      state.status === 'queued' ||
      state.status === 'downloading' ||
      state.status === 'verifying' ||
      state.status === 'self-testing'
    ) {
      return SpeechPackActionResultSchema.parse({ ok: false, reason: 'busy' })
    }
    activity.add(component.id)
    activeAuthority.set(component.id, {
      policyIdentity: record.policyIdentity,
      selectionIdentity: record.selectionIdentity,
      captureIdentity: record.captureIdentity
    })
    currentProgress = {
      componentId: component.id,
      manifestIdentity: record.plan.missingComponents[0].manifestIdentity,
      bytesDone: 0,
      bytesTotal: componentDownloadBytes(component),
      state: 'queued'
    }
    if (request.action === 'repair') instance.repair(component.id)
    else instance.enqueue([component.id], component.id)
    return SpeechPackActionResultSchema.parse({ ok: true })
  }

  const action = async (value: unknown): Promise<SpeechPackActionResult> => {
    const parsedRequest = SpeechPackActionRequestSchema.safeParse(value)
    if (!parsedRequest.success) return SpeechPackActionResultSchema.parse({ ok: false, reason: 'invalid-request' })
    const request: SpeechPackActionRequest = parsedRequest.data
    const result = (response: SpeechPackActionResult): SpeechPackActionResult =>
      SpeechPackActionResultSchema.parse(response)
    const component = byId.get(request.componentId)
    if (!component) return result({ ok: false, reason: 'invalid-request' })
    if (componentManifestIdentity(component) !== request.manifestIdentity)
      return result({ ok: false, reason: 'stale-manifest' })
    if (sourceHost(component) === null) return result({ ok: false, reason: 'not-configured' })
    if (request.action === 'pause' || request.action === 'cancel') {
      authorityRevision += 1
      pendingAdmissions.delete(component.id)
      if (!engine) return result({ ok: true })
      if (request.action === 'pause') engine.pause(component.id)
      else engine.cancel(component.id)
      activity.delete(component.id)
      activeAuthority.delete(component.id)
      return result({ ok: true })
    }
    return result({ ok: false, reason: 'unavailable' })
  }

  return {
    snapshot,
    action,
    planPreview,
    installWithPlan,
    subscribe(listener: (progress: SpeechPackProgress) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    policyChanged(): void {
      const nextIdentity = currentPolicyIdentity()
      const identityChanged = nextIdentity !== observedPolicyIdentity
      observedPolicyIdentity = nextIdentity
      if (!identityChanged && nextIdentity !== null && policyAllows() && featureEnabled()) return
      authorityRevision += 1
      installPlans.clear()
      for (const id of activity) engine?.cancel(id)
      activity.clear()
      activeAuthority.clear()
    },
    selectionChanged(): void {
      const nextEngine = options.selectedEngine()
      const nextIdentity = currentSelectionIdentity()
      if (nextEngine === observedSelection && nextIdentity === observedSelectionIdentity) return
      observedSelection = nextEngine
      observedSelectionIdentity = nextIdentity
      authorityRevision += 1
      installPlans.clear()
      for (const id of activity) engine?.cancel(id)
      activity.clear()
      activeAuthority.clear()
    },
    captureActivityChanged(active: boolean): void {
      if (captureActive !== active) {
        authorityRevision += 1
        installPlans.clear()
      }
      captureActive = active
      if (!active) return
      for (const id of activity) engine?.pause(id)
    },
    async shutdown(): Promise<void> {
      closing = true
      authorityRevision += 1
      installPlans.clear()
      pendingAdmissions.clear()
      if (engine) for (const component of components) engine.cancel(component.id)
      activity.clear()
      activeAuthority.clear()
      if (engine) {
        let timeout: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          engine.whenIdle().catch(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, options.shutdownTimeoutMs ?? 10_000)
          })
        ])
        clearTimeout(timeout)
      }
      unsubscribe?.()
      unsubscribe = null
      listeners.clear()
    },
    /** Test seam: verifies status stays cold and no engine exists before explicit action. */
    hasEngine(): boolean {
      return engine !== null
    }
  }
}

export type SpeechPackService = ReturnType<typeof createSpeechPackService>
export type {
  SpeechPackActionRequest,
  SpeechPackActionResult,
  SpeechPackComponentSnapshot,
  SpeechPackInstallWithPlanRequest,
  SpeechPackInstallWithPlanResult,
  SpeechPackPlanPreviewRequest,
  SpeechPackPlanPreviewResult,
  SpeechPackProgress,
  SpeechPackSnapshot
} from '@shared/speech-pack'
