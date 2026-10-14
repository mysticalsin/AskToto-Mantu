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
  /** Unknown managed/admin policy must never be interpreted as an unmanaged profile. */
  authorityReadable: boolean
}

const FRESH_LEAN_BROKER_DEFAULT = Object.freeze({
  transport: 'broker-v1' as const,
  engine: 'cloudflare-nova3' as const
})

/** Whether a persisted route may be derived for this exact fresh, verified, unmanaged lean profile. */
export function canProjectFreshLeanSpeechDefaults(context: FreshLeanSpeechDefaultContext): boolean {
  const { settings } = context
  if (
    context.compiledPackageProfile !== 'lean' ||
    context.verifiedPackageProfile !== 'lean' ||
    context.freshProfile !== true ||
    context.authorityReadable !== true ||
    settings.onboardingDone !== false ||
    context.speechRouteExplicit !== false ||
    !Array.isArray(context.managedKeys) ||
    !Array.isArray(context.lockedKeys) ||
    context.managedKeys.length > 0 ||
    context.lockedKeys.includes('brokerSpeech') ||
    context.lockedKeys.includes('cloudSttProvider') ||
    settings.cloudSttProvider !== 'unconfigured' ||
    !settings.enterpriseLive ||
    settings.enterpriseLive.managed !== false ||
    settings.enterpriseLive.inferenceMode !== 'legacy' ||
    settings.enterpriseLive.summaryOnly !== false
  )
    return false

  const broker = BrokerSpeechSettingsSchema.safeParse(settings.brokerSpeech)
  if (
    !broker.success ||
    broker.data.transport !== DEFAULT_BROKER_SPEECH_SETTINGS.transport ||
    broker.data.engine !== DEFAULT_BROKER_SPEECH_SETTINGS.engine
  )
    return false

  return true
}

/** Applies only the proposed fresh lean broker default; every other Settings field stays unchanged. */
export function projectFreshLeanSpeechDefaults(context: FreshLeanSpeechDefaultContext): Settings {
  if (!canProjectFreshLeanSpeechDefaults(context)) return context.settings

  return { ...context.settings, brokerSpeech: { ...FRESH_LEAN_BROKER_DEFAULT } }
}
