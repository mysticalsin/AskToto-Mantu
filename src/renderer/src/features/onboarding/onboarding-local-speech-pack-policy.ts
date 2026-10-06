import type { PublicSettings } from '@shared/ipc'

export type LocalSpeechPackSetting = PublicSettings['localSpeechPack'] | null | undefined

export function speechPackAllowsEnsure(policy: LocalSpeechPackSetting): boolean {
  return policy !== 'blocked'
}

export function speechPackSetupRowVisible(policy: LocalSpeechPackSetting): boolean {
  return speechPackAllowsEnsure(policy)
}
