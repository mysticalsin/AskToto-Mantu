import { BrokerSpeechSettingsSchema } from '@shared/broker-speech-settings'
import { EnterpriseLiveProfileSchema } from '@shared/enterprise-live-profile'
import type { ManagedSpeechPolicyRead } from './managed-speech-providers'
import type { SettingsPolicyAuthoritySnapshot } from './settings-observation'

const LEGACY_SPEECH_SETTING_LOCKS = new Set([
  'enterpriseLive',
  'cloudSttProvider',
  'brokerSpeech',
  'cloudflareAccountId',
  'cfAiGatewayId',
  'soniox'
])

export type LegacyCloudSttAdmission =
  | { ok: true; settings: SettingsPolicyAuthoritySnapshot['settings'] }
  | { ok: false; error: string; code: 'APPROVED_GATEWAY_REQUIRED' }

const refused = (): LegacyCloudSttAdmission => ({
  ok: false,
  error: 'This profile requires the approved speech gateway.',
  code: 'APPROVED_GATEWAY_REQUIRED'
})

/** Admit only readable, unmanaged legacy settings with no active managed speech route policy. */
export function legacyCloudSttAdmission(
  authority: SettingsPolicyAuthoritySnapshot,
  managedPolicy: ManagedSpeechPolicyRead
): LegacyCloudSttAdmission {
  if (!authority || authority.readable !== true || !authority.settings || !Array.isArray(authority.lockedKeys)) {
    return refused()
  }
  if (authority.allowedProviders !== null) return refused()
  if (authority.lockedKeys.some((key) => LEGACY_SPEECH_SETTING_LOCKS.has(key))) return refused()
  if (managedPolicy.state === 'invalid') return refused()
  if (managedPolicy.state === 'valid' && managedPolicy.providers.state !== 'absent') return refused()

  const profile = EnterpriseLiveProfileSchema.safeParse(authority.settings.enterpriseLive)
  const broker = BrokerSpeechSettingsSchema.safeParse(authority.settings.brokerSpeech)
  if (!profile.success || !broker.success || profile.data.managed || broker.data.transport !== 'legacy') return refused()

  return { ok: true, settings: authority.settings }
}
