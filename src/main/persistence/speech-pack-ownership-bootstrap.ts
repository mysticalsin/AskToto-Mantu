import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  createRuntimePayloadPlanIssuer,
  type RuntimePayloadPlanIssuer,
  type RuntimePayloadWritePlan
} from '../infra/storage/runtime-payload-plan'
import type { RuntimePackNamespace } from '../infra/storage/runtime-pack-namespace'
import {
  createSpeechPackOwnershipStore,
  type SpeechPackOwnershipStore,
  type SpeechPackRegistryBackend
} from '../features/components/speech-pack/ownership-registry'
import {
  SPEECH_PACK_COMPONENTS,
  componentBytes,
  type SpeechPackComponent
} from '../features/components/speech-pack/manifest'
import { componentManifestIdentity } from '../features/components/speech-pack/resolver'
import { captureMainSpeechPackPurposeRoot } from './main-bootstrap-lifecycle'
import { createMainSpeechPackKeyAnchorOwner } from './speech-pack-key-anchor-owner'
import { createProtectedSpeechPackReceiptKeys } from './protected-speech-pack-receipt-keys'
import { createSpeechPackRegistryBackend } from './speech-pack-ownership-store'
import type { ProtectedSpeechPackReceiptKeys, SpeechPackReceiptKeyHandle } from './speech-pack-receipt-key-contract'
import {
  decryptMeetingEnvelopeAsync,
  encryptMeetingEnvelopeAsync,
  getMeetingSpeechReadLimitBytes,
  isMeetingSpeechPersistenceConfigured
} from '../features/meetings/meeting-speech'
import {
  assertCurrentSpeechPackInstallAdmission,
  type CurrentSpeechPackInstallAdmission
} from '../features/components/speech-pack/install-admission'

export interface SpeechPackOwnershipSession {
  readonly store: SpeechPackOwnershipStore
  readonly payloadRootPath: string
  /** Payload namespace is app-data storage, distinct from the profile key/registry root. */
  readonly payloadNamespace: RuntimePackNamespace
  readonly stagingPlan: RuntimePayloadWritePlan
  readonly activePlan: RuntimePayloadWritePlan
  readonly archiveWorkPlan: RuntimePayloadWritePlan | null
  settleAndDispose(): Promise<void>
}

function planPathBytes(root: string, files: readonly ({ path: string } | { relativePath: string })[]): number {
  let total = Buffer.byteLength(root)
  const directories = new Set<string>()
  for (const file of files) {
    const path = 'path' in file ? file.path : file.relativePath
    total += Buffer.byteLength(path)
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/')
      if (!directories.has(directory)) {
        directories.add(directory)
        total += Buffer.byteLength(directory)
      }
    }
  }
  return total
}

function createPlans(
  issuer: RuntimePayloadPlanIssuer,
  component: SpeechPackComponent,
  resourcePolicyIdentity: string
): {
  staging: RuntimePayloadWritePlan
  active: RuntimePayloadWritePlan
  archiveWork: RuntimePayloadWritePlan | null
} {
  const manifestIdentity = componentManifestIdentity(component)
  const policyIdentity = createHash('sha256')
    .update('metis-speech-pack-resource-policy/v1\0')
    .update(resourcePolicyIdentity)
    .digest('hex')
  const files = component.files.map((file) => ({
    relativePath: file.path,
    byteLength: file.bytes,
    sha256: file.sha256
  }))
  const byteLength = componentBytes(component)
  const pathBytes = planPathBytes(`.staging/${component.id}/${component.version}`, component.files)
  const shared = {
    componentId: component.id,
    componentVersion: component.version,
    manifestIdentity,
    resourcePolicyIdentity: policyIdentity,
    files,
    admittedMaximumBytes: byteLength,
    admittedMaximumFiles: files.length,
    admittedMaximumPathBytes: pathBytes
  }
  const staging = issuer.issue({ ...shared, rootRelativePath: `.staging/${component.id}/${component.version}` })
  const active = issuer.issue({ ...shared, rootRelativePath: `${component.id}/${component.version}` })
  let archiveWork: RuntimePayloadWritePlan | null = null
  if (component.source.kind === 'archive' && component.source.archive) {
    const workRoot = `.staging/${component.id}/work`
    const workFiles = [
      {
        relativePath: 'archive.download',
        byteLength: component.source.archive.bytes,
        sha256: component.source.archive.sha256
      }
    ]
    archiveWork = issuer.issue({
      componentId: component.id,
      componentVersion: component.version,
      manifestIdentity,
      resourcePolicyIdentity: policyIdentity,
      rootRelativePath: workRoot,
      files: workFiles,
      admittedMaximumBytes: component.source.archive.bytes,
      admittedMaximumFiles: 1,
      admittedMaximumPathBytes: planPathBytes(workRoot, workFiles)
    })
  }
  return { staging, active, archiveWork }
}

/** Opens a purpose-bound receipt registry only from a current service-issued install admission. */
export async function openSpeechPackOwnershipSession(
  admission: CurrentSpeechPackInstallAdmission
): Promise<SpeechPackOwnershipSession> {
  await assertCurrentSpeechPackInstallAdmission(admission)
  if (
    (admission.operation !== 'install' && admission.operation !== 'repair') ||
    !['asr.whisper-base-q8', 'asr.parakeet-tdt-0.6b-v3-int8'].includes(admission.componentId)
  )
    throw new Error('Speech-pack ownership requires an admitted component install operation')
  if (Buffer.byteLength(admission.resourcePolicyIdentity) > 4096) {
    throw new Error('Speech-pack ownership requires a current resource policy identity')
  }
  const component = SPEECH_PACK_COMPONENTS.find((candidate) => candidate.id === admission.componentId)
  if (!component) throw new Error('Speech-pack ownership component is not in the compiled catalog')
  const lease = await captureMainSpeechPackPurposeRoot('create')
  await assertCurrentSpeechPackInstallAdmission(admission)
  const createRegistry = lease.keyRootFresh
  const storeMode = createRegistry ? 'create-explicit' : 'open-existing'
  let key: SpeechPackReceiptKeyHandle | null = null
  let keys: ProtectedSpeechPackReceiptKeys | null = null
  let backend: SpeechPackRegistryBackend | null = null
  let planIssuer: RuntimePayloadPlanIssuer | null = null
  try {
    lease.scope.assertCurrent()
    await lease.scope.assertPhysicalCurrent()
    await assertCurrentSpeechPackInstallAdmission(admission)
    if (!isMeetingSpeechPersistenceConfigured()) {
      throw new Error('The main speech persistence worker is unavailable for protected speech-pack ownership.')
    }
    keys = createProtectedSpeechPackReceiptKeys({
      anchorOwner: createMainSpeechPackKeyAnchorOwner(lease),
      speech: {
        encryptEnvelopeV2: encryptMeetingEnvelopeAsync,
        decryptEnvelopeV2: decryptMeetingEnvelopeAsync,
        readLimitBytes: () => getMeetingSpeechReadLimitBytes() ?? 0
      }
    })
    key = createRegistry
      ? await keys.createForExplicitInstall(lease.scope, lease.keyRegistryRoot)
      : await keys.openExistingForRecovery(lease.scope, lease.keyRegistryRoot)
    lease.scope.assertCurrent()
    await assertCurrentSpeechPackInstallAdmission(admission)
    backend = await createSpeechPackRegistryBackend({
      scope: lease.scope,
      root: lease.keyPurposeRoot,
      key,
      mode: storeMode,
      assertMainInstanceCurrentSync: lease.scope.assertCurrent
    })
    await assertCurrentSpeechPackInstallAdmission(admission)
    const store = await createSpeechPackOwnershipStore({
      binding: {
        profileNamespace: lease.scope.profileNamespace,
        profileGeneration: lease.scope.profileGeneration,
        principalAssociation: lease.scope.principalAssociation,
        registryRootBinding: lease.keyRootBindingId,
        keyId: key.keyId
      },
      backend,
      mode: storeMode
    })
    await assertCurrentSpeechPackInstallAdmission(admission)
    planIssuer = createRuntimePayloadPlanIssuer()
    const plans = createPlans(planIssuer, component, admission.resourcePolicyIdentity)
    await assertCurrentSpeechPackInstallAdmission(admission)
    let disposal: Promise<void> | null = null
    return Object.freeze({
      store,
      payloadRootPath: lease.rootPath,
      payloadNamespace: lease.namespace,
      stagingPlan: plans.staging,
      activePlan: plans.active,
      archiveWorkPlan: plans.archiveWork,
      settleAndDispose() {
        if (disposal) return disposal
        disposal = (async () => {
          try {
            planIssuer?.retire()
            await store.settleAndDispose()
          } finally {
            await lease.dispose()
          }
        })()
        return disposal
      }
    })
  } catch (error) {
    planIssuer?.retire()
    if (backend) await backend.settleAndDispose().catch(() => undefined)
    else if (key) {
      keys?.retire(key)
      await keys?.settleAndDispose(key).catch(() => undefined)
    }
    await lease.dispose().catch(() => undefined)
    throw error
  }
}
