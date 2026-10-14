import type { SpeechPackComponentId } from './manifest'

declare const speechPackInstallAdmissionBrand: unique symbol
declare const currentSpeechPackInstallAdmissionBrand: unique symbol

export type SpeechPackInstallAdmission = { readonly [speechPackInstallAdmissionBrand]: true }

export interface SpeechPackInstallAdmissionBinding {
  readonly operation: 'install' | 'repair'
  readonly componentId: SpeechPackComponentId
  readonly manifestIdentity: string
  readonly resourcePolicyIdentity: string
  readonly transaction: symbol
  readonly assertCurrent: () => boolean
  readonly refreshCurrent: () => Promise<boolean>
}

const issued = new WeakMap<object, SpeechPackInstallAdmissionBinding>()
const resolved = new WeakMap<object, true>()

/** Minted only after the main service consumes a current, explicit install plan. */
export function createSpeechPackInstallAdmission(
  binding: SpeechPackInstallAdmissionBinding
): SpeechPackInstallAdmission {
  if (
    !binding.transaction ||
    !/^[a-f0-9]{64}$/.test(binding.manifestIdentity) ||
    binding.resourcePolicyIdentity.length === 0 ||
    binding.resourcePolicyIdentity.length > 256
  ) {
    throw new Error('SPEECH_PACK_INSTALL_ADMISSION_INVALID')
  }
  const admission = Object.freeze(Object.create(null)) as SpeechPackInstallAdmission
  issued.set(admission, Object.freeze({ ...binding }))
  return admission
}

export interface CurrentSpeechPackInstallAdmission {
  readonly [currentSpeechPackInstallAdmissionBrand]: true
  readonly operation: 'install' | 'repair'
  readonly componentId: SpeechPackComponentId
  readonly manifestIdentity: string
  readonly resourcePolicyIdentity: string
  readonly transaction: symbol
  assertCurrent(): void
  assertCurrentAsync(): Promise<void>
}

export function resolveSpeechPackInstallAdmission(
  admission: SpeechPackInstallAdmission,
  componentId: SpeechPackComponentId,
  transaction: symbol
): CurrentSpeechPackInstallAdmission {
  const binding = issued.get(admission as object)
  if (!binding || binding.componentId !== componentId || binding.transaction !== transaction) {
    throw new Error('SPEECH_PACK_INSTALL_ADMISSION_MISMATCH')
  }
  const assertCurrent = (): void => {
    if (!binding.assertCurrent()) throw new Error('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
  }
  const current = Object.freeze({
    [currentSpeechPackInstallAdmissionBrand]: true as const,
    operation: binding.operation,
    componentId: binding.componentId,
    manifestIdentity: binding.manifestIdentity,
    resourcePolicyIdentity: binding.resourcePolicyIdentity,
    transaction: binding.transaction,
    assertCurrent,
    async assertCurrentAsync(): Promise<void> {
      assertCurrent()
      if (!(await binding.refreshCurrent())) throw new Error('SPEECH_PACK_INSTALL_ADMISSION_EXPIRED')
      assertCurrent()
    }
  }) as CurrentSpeechPackInstallAdmission
  resolved.set(current, true)
  return current
}

export async function assertCurrentSpeechPackInstallAdmission(
  admission: CurrentSpeechPackInstallAdmission
): Promise<void> {
  if (!resolved.has(admission as object)) throw new Error('SPEECH_PACK_INSTALL_ADMISSION_INVALID')
  await admission.assertCurrentAsync()
}
