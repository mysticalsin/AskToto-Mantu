import type { Settings } from '@shared/ipc'
import type { LocalSpeechPackPolicy } from '@shared/model-policy'
import { modelPolicyCapabilitiesForSettings, resolveLocalSpeechPackPolicy } from './model-policy-client'

export { modelPolicyCapabilitiesForSettings }

export function localSpeechPackBlockedForSettings(s: Settings, adminPolicy: LocalSpeechPackPolicy | null): boolean {
  return resolveLocalSpeechPackPolicy(s, adminPolicy) === 'blocked'
}
