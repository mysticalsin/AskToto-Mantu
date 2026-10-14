import type { Settings } from '@shared/ipc'
import { BrokerSpeechSettingsSchema, DEFAULT_BROKER_SPEECH_SETTINGS } from '@shared/broker-speech-settings'

type PackageProfile = 'full' | 'lean'

/** Main-only durable facts captured before any default Settings file is created. */
export type FreshLeanSpeechDefaultContext = {
  settings: Settings
  compiledPackageProfile: PackageProfile | null
  verifiedPackageProfile: PackageProfile | null
  /** True only when the user profile was absent before the current initialization began. */
  freshProfile: boolean
  /** True when persisted settings contained brokerSpeech or cloudSttProvider. */
  speechRouteExplicit: boolean
  managedKeys: readonly string[]
  lockedKeys: readonly string[]
}

const FRESH_LEAN_BROKER_DEFAULT = Object.freeze({
  transport: 'broker-v1' as const,
  engine: 'cloudflare-nova3' as const
})

/** Applies only the proposed fresh lean broker default; every other Settings field stays unchanged. */
export function projectFreshLeanSpeechDefaults(context: FreshLeanSpeechDefaultContext): Settings {
  const { settings } = context
  if (
    context.compiledPackageProfile !== 'lean' ||
    context.verifiedPackageProfile !== 'lean' ||
    context.freshProfile !== true ||
    settings.onboardingDone !== false ||
    context.speechRouteExplicit !== false ||
    !Array.isArray(context.managedKeys) ||
    !Array.isArray(context.lockedKeys) ||
    context.managedKeys.includes('brokerSpeech') ||
    context.managedKeys.includes('cloudSttProvider') ||
    context.lockedKeys.includes('brokerSpeech') ||
    context.lockedKeys.includes('cloudSttProvider') ||
    settings.cloudSttProvider !== 'unconfigured' ||
    !settings.enterpriseLive ||
    settings.enterpriseLive.managed !== false ||
    settings.enterpriseLive.inferenceMode !== 'legacy' ||
    settings.enterpriseLive.summaryOnly !== false
  )
    return settings

  const broker = BrokerSpeechSettingsSchema.safeParse(settings.brokerSpeech)
  if (
    !broker.success ||
    broker.data.transport !== DEFAULT_BROKER_SPEECH_SETTINGS.transport ||
    broker.data.engine !== DEFAULT_BROKER_SPEECH_SETTINGS.engine
  )
    return settings

  return { ...settings, brokerSpeech: { ...FRESH_LEAN_BROKER_DEFAULT } }
}
