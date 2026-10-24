import type { OptionalComponentId, OptionalComponentStatus } from '../../../../shared/speech-pack'
import {
  BLOCKED_BY_FAILURE_MODE,
  LOCAL_MODEL_REASON_FAILURE_MODE,
  SPEECH_ROW_STATE_FAILURE_MODE,
  type FailureMode,
  type LocalModelReasonName
} from '../../../../shared/component-failure-matrix'
import { OPTIONAL_COMPONENT_DESCRIPTORS, type OptionalComponentDescriptor } from './optional-component-descriptors'
import type { SpeechPackComponentId } from './manifest'
import type { PackageRuntimeContract } from './package-contract'
import {
  resolveOptionalRuntimeReadiness,
  runtimeHostFacts,
  type OptionalRuntimeHostFacts,
  type OptionalRuntimeReadiness
} from './runtime-components'

export type { OptionalComponentId, OptionalComponentStatus }

/** What the local LLM registry and runtime report about the downloaded model (G87). Main supplies it. */
export interface LocalModelFacts {
  /** Both weight files are present with their pinned sizes. */
  downloaded: boolean
  /** 'bundled' files ship inside the application and are never removable. */
  source: 'bundled' | 'download'
  reason: LocalModelReasonName | null
  runtimeState: 'stopped' | 'starting' | 'running' | 'unavailable'
}

/** One speech-pack row as the service snapshot reports it. */
export interface SpeechRowFacts {
  componentId: SpeechPackComponentId
  state: keyof typeof SPEECH_ROW_STATE_FAILURE_MODE
  requiredBytes?: number
  freeBytes?: number
}

export interface OptionalComponentFacts {
  contract: PackageRuntimeContract
  host?: OptionalRuntimeHostFacts
  /** Components whose verified weights are already on disk (for example a ready speech-pack row). */
  installed: ReadonlySet<OptionalComponentId>
  /** Speech-pack rows, for the distinct failure of a speech component (G87). */
  speechRows?: readonly SpeechRowFacts[]
  /** Local LLM registry and runtime facts; without them the local LLM is judged by `installed` alone. */
  localModel?: LocalModelFacts
}

function worstReadiness(values: readonly OptionalRuntimeReadiness[]): OptionalRuntimeReadiness {
  if (values.includes('incompatible')) return 'incompatible'
  if (values.includes('not-configured')) return 'not-configured'
  return 'ready'
}

function blockedBy(
  contract: PackageRuntimeContract,
  readiness: OptionalRuntimeReadiness
): OptionalComponentStatus['blockedBy'] {
  if (contract.status === 'invalid') return 'package-invalid'
  if (readiness === 'incompatible') return 'package-incompatible'
  if (readiness === 'not-configured') return 'runtime-not-published'
  return null
}

function presenceFor(
  contract: PackageRuntimeContract,
  weightsInstalled: boolean,
  runtimeReady: boolean
): OptionalComponentStatus['presence'] {
  // A full 1.9.x package carries these models and runtimes inside the application. Detect that first, so an
  // install upgraded in place from 1.9.7 never reports a bundled model as missing.
  if (contract.status === 'legacy-full' || (contract.status === 'verified' && contract.profile === 'full')) {
    return 'bundled'
  }
  if (!weightsInstalled) return 'absent'
  return runtimeReady ? 'installed' : 'model-only'
}

/**
 * The one live failure of a component, in a fixed order so each kind stays distinct (G87): the package, then the
 * runtime, then the weights (a disk shortage outranks a generic failed download), then a sidecar that will not
 * start. Null when nothing is wrong. Pure.
 */
function failureFor(
  descriptor: OptionalComponentDescriptor,
  facts: OptionalComponentFacts,
  blocked: OptionalComponentStatus['blockedBy'],
  presence: OptionalComponentStatus['presence']
): FailureMode | null {
  if (blocked) return BLOCKED_BY_FAILURE_MODE[blocked]
  // A bundled component has no download or repair path of its own; its package status is the only signal.
  if (presence === 'bundled') return null
  const row = facts.speechRows?.find((item) => item.componentId === descriptor.modelComponentId)
  if (row) {
    if (
      row.state === 'error' &&
      row.requiredBytes !== undefined &&
      row.freeBytes !== undefined &&
      row.requiredBytes > row.freeBytes
    )
      return 'insufficient-disk'
    const mode = SPEECH_ROW_STATE_FAILURE_MODE[row.state]
    if (mode) return mode
  }
  const model = descriptor.localModelId !== null ? facts.localModel : undefined
  if (model) {
    if (model.reason) {
      const mode = LOCAL_MODEL_REASON_FAILURE_MODE[model.reason]
      if (mode) return mode
    }
    if (model.downloaded && model.runtimeState === 'unavailable') return 'startup-failed'
  }
  return null
}

function statusFor(descriptor: OptionalComponentDescriptor, facts: OptionalComponentFacts): OptionalComponentStatus {
  const host = facts.host ?? runtimeHostFacts()
  // Every runtime of the component must be ready; an incompatible one outranks one that is not configured.
  const readiness = worstReadiness(
    descriptor.runtimeIds.map((runtimeId) => resolveOptionalRuntimeReadiness(runtimeId, facts.contract, host))
  )
  const blocked = blockedBy(facts.contract, readiness)
  const localModel = descriptor.localModelId !== null ? facts.localModel : undefined
  // local-llm has no speech-pack row; its weights are present when the registry says both files are.
  const weightsInstalled = facts.installed.has(descriptor.id) || localModel?.downloaded === true
  const presence = presenceFor(facts.contract, weightsInstalled, readiness === 'ready')
  const removable =
    (presence === 'installed' || presence === 'model-only') &&
    (localModel === undefined || localModel.source === 'download')
  return {
    id: descriptor.id,
    label: descriptor.label,
    provider: descriptor.provider,
    sourceHost: descriptor.sourceHost,
    privacy: descriptor.privacy,
    privacyNote: descriptor.privacyNote,
    downloadBytes: descriptor.downloadBytes,
    installedBytes: descriptor.installedBytes,
    presence,
    blockedBy: blocked,
    failure: failureFor(descriptor, facts, blocked, presence),
    installable: blocked === null && (presence === 'absent' || presence === 'model-only'),
    removable,
    removableBytes: removable ? descriptor.installedBytes : 0,
    offer: { surface: descriptor.offer.surface, consent: descriptor.offer.consent }
  }
}

/** The provider's facts, or undefined when it is absent or throws: an unreadable registry reads as unknown. */
export function readLocalModelFacts(provider?: () => LocalModelFacts | undefined): LocalModelFacts | undefined {
  try {
    return provider?.()
  } catch {
    return undefined
  }
}

/** What each optional component is on this install, in descriptor order. Pure: no I/O, no download. */
export function resolveOptionalComponents(facts: OptionalComponentFacts): OptionalComponentStatus[] {
  return OPTIONAL_COMPONENT_DESCRIPTORS.map((descriptor) => statusFor(descriptor, facts))
}

/** The components whose speech-pack model row is already verified on disk (a ready download). */
export function installedOptionalComponents(
  rows: readonly { componentId: SpeechPackComponentId; state: string }[]
): Set<OptionalComponentId> {
  return new Set(
    OPTIONAL_COMPONENT_DESCRIPTORS.filter(
      (descriptor) =>
        descriptor.modelComponentId !== null &&
        rows.some((row) => row.componentId === descriptor.modelComponentId && row.state === 'ready')
    ).map((descriptor) => descriptor.id)
  )
}
