import { localModelAllowedByPolicy, type ModelPolicyDocument } from '@shared/model-policy'
import type { Settings } from '@shared/ipc'
import { speechPolicyIsConfigured } from './speech-policy-authority'

export type LocalProvisioningSettings = Pick<
  Settings,
  'localLlm' | 'enterpriseLive' | 'operatorUrl' | 'operatorIngestSecret' | 'operatorLicenseToken'
>

export type ExplicitLocalModelSettingsSnapshot = {
  settings: LocalProvisioningSettings
  readable: boolean
  allowedProviders: readonly string[] | null
  modelPolicy:
    | { status: 'unconfigured' | 'unmanaged'; identity: string }
    | { status: 'managed'; identity: string; policy: ModelPolicyDocument }
    | { status: 'unverified'; identity: string }
}

/** Optional LLM provisioning policy. Transcription assets have a separate mandatory setup path. */
export async function provisionLocalModel(
  local: { enabled: boolean; modelId: string },
  allowedProviders: readonly string[] | null,
  ensure: (modelId: string) => Promise<boolean>,
  trigger: 'automatic' | 'explicit' = 'automatic'
): Promise<boolean> {
  if (allowedProviders && !allowedProviders.includes('local')) return false
  if (trigger === 'automatic' && !local.enabled) return false
  // The downloader owns model-id, RAM, disk, integrity and single-flight checks. Never replace the
  // selected model with a larger one merely because this machine has enough memory for it.
  return ensure(local.modelId)
}

/** Explicit user action admission; each read callback is a fresh policy/profile authority boundary. */
export async function provisionExplicitLocalModel(options: {
  captureActive: () => boolean
  captureIdentity: () => string
  runtimeAvailable: () => Promise<boolean>
  localModelIdentity: () => string
  currentModelPolicyIdentity: () => string
  readSettings: () => Promise<ExplicitLocalModelSettingsSnapshot>
  ensure: (modelId: string, authorized: () => Promise<boolean>, validateCurrent: () => boolean) => Promise<boolean>
  onReady: () => void
}): Promise<boolean> {
  if (!(await options.runtimeAvailable())) return false
  if (options.captureActive()) return false
  const captureIdentity = options.captureIdentity()
  const localModelIdentity = options.localModelIdentity()
  const admission = await options.readSettings()
  const modelId = admission.settings.localLlm.modelId
  const isAllowed = (snapshot: Awaited<ReturnType<typeof options.readSettings>>): boolean =>
    snapshot.readable &&
    snapshot.modelPolicy.status !== 'unverified' &&
    (snapshot.modelPolicy.status !== 'unconfigured' ||
      (!speechPolicyIsConfigured(snapshot.settings) &&
        snapshot.settings.enterpriseLive.managed === false &&
        snapshot.settings.enterpriseLive.inferenceMode === 'legacy')) &&
    !(snapshot.allowedProviders && !snapshot.allowedProviders.includes('local')) &&
    (snapshot.modelPolicy.status !== 'managed' || localModelAllowedByPolicy(snapshot.modelPolicy.policy, modelId))
  if (!isAllowed(admission) || options.captureActive()) return false
  const proofIdentity = admission.modelPolicy.identity
  const validateCurrent = (): boolean =>
    !options.captureActive() &&
    options.captureIdentity() === captureIdentity &&
    options.localModelIdentity() === localModelIdentity &&
    options.currentModelPolicyIdentity() === proofIdentity
  const authorized = async (): Promise<boolean> => {
    if (!validateCurrent()) return false
    const current = await options.readSettings()
    return (
      isAllowed(current) &&
      current.settings.localLlm.modelId === modelId &&
      current.modelPolicy.identity === proofIdentity &&
      validateCurrent()
    )
  }
  if (!(await authorized())) return false
  const admittedModel = admission.settings.localLlm
  const ready = await provisionLocalModel(
    admittedModel,
    admission.allowedProviders,
    (id) => options.ensure(id, authorized, validateCurrent),
    'explicit'
  )
  if (!ready) return false
  const current = await options.readSettings()
  if (
    !isAllowed(current) ||
    current.settings.localLlm.modelId !== admittedModel.modelId ||
    current.modelPolicy.identity !== proofIdentity ||
    !validateCurrent()
  )
    return false
  options.onReady()
  return true
}
