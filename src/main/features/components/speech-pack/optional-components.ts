import type { OptionalComponentId, OptionalComponentStatus } from '../../../../shared/speech-pack'
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

export interface OptionalComponentFacts {
  contract: PackageRuntimeContract
  host?: OptionalRuntimeHostFacts
  /** Components whose verified weights are already on disk (for example a ready speech-pack row). */
  installed: ReadonlySet<OptionalComponentId>
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

function statusFor(descriptor: OptionalComponentDescriptor, facts: OptionalComponentFacts): OptionalComponentStatus {
  const host = facts.host ?? runtimeHostFacts()
  // Every runtime of the component must be ready; an incompatible one outranks one that is not configured.
  const readiness = worstReadiness(
    descriptor.runtimeIds.map((runtimeId) => resolveOptionalRuntimeReadiness(runtimeId, facts.contract, host))
  )
  const blocked = blockedBy(facts.contract, readiness)
  const presence = presenceFor(facts.contract, facts.installed.has(descriptor.id), readiness === 'ready')
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
    installable: blocked === null && (presence === 'absent' || presence === 'model-only'),
    offer: { surface: descriptor.offer.surface, consent: descriptor.offer.consent }
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
