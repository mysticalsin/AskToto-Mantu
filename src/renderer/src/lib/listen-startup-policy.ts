import {
  operatorGate,
  emptyOperatorEntitlements,
  type OperatorEntitlementSnapshot
} from '@shared/operator-entitlements'
import { shouldUseCloudSttEngine } from '@shared/cloud-stt-provider'
import { resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'

type OperatorSettings = {
  operatorConfigured?: boolean
  operatorEntitlementsAt?: number
  operatorTier?: OperatorEntitlementSnapshot['tier']
  operatorEntitlements?: OperatorEntitlementSnapshot['entitlements'] | null
}

export function listenOperatorGateNotice(settings: OperatorSettings): string | null {
  const snapshot: OperatorEntitlementSnapshot | null = settings.operatorEntitlementsAt
    ? {
        tier: settings.operatorTier ?? null,
        entitlements: settings.operatorEntitlements ?? emptyOperatorEntitlements(),
        at: settings.operatorEntitlementsAt
      }
    : null
  const gate = operatorGate('listen', settings.operatorConfigured === true, snapshot)
  return gate.allowed ? null : gate.reason || 'Listen is not available.'
}

type ListenEngine = 'whisper' | 'parakeet' | 'apple' | 'cloud'

export function resolveListenEngine(
  settings?: {
    brokerSpeech?: { transport?: string }
    enterpriseLive?: Parameters<typeof resolveEnterpriseLiveProfile>[0]
    cloudSttProvider?: Parameters<typeof shouldUseCloudSttEngine>[1]
    asrEngine?: ListenEngine
  } | null
): ListenEngine {
  if (settings?.brokerSpeech?.transport === 'broker-v1') return 'cloud'
  const profile = resolveEnterpriseLiveProfile(settings?.enterpriseLive)
  return shouldUseCloudSttEngine(profile, settings?.cloudSttProvider) ? 'cloud' : (settings?.asrEngine ?? 'parakeet')
}
