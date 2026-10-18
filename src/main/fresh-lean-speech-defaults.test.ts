import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'
import { DEFAULT_BROKER_SPEECH_SETTINGS } from '@shared/broker-speech-settings'
import { projectFreshLeanSpeechDefaults, type FreshLeanSpeechDefaultContext } from './fresh-lean-speech-defaults'

function input(
  overrides: Partial<FreshLeanSpeechDefaultContext> = {},
  settingsOverrides: Partial<Settings> = {}
): FreshLeanSpeechDefaultContext {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settingsOverrides },
    compiledPackageProfile: 'lean',
    verifiedPackageProfile: 'lean',
    freshProfile: true,
    speechRouteExplicit: false,
    managedKeys: [],
    lockedKeys: [],
    authorityReadable: true,
    ...overrides
  }
}

describe('fresh lean broker default projection', () => {
  it('selects the Deepgram broker only for a verified, genuinely fresh, unmanaged lean profile', () => {
    const source = input()
    const result = projectFreshLeanSpeechDefaults(source)

    expect(result.brokerSpeech).toEqual({ transport: 'broker-v1', engine: 'deepgram-nova3' })
    expect(result).toMatchObject({
      onboardingDone: false,
      asrEngine: DEFAULT_SETTINGS.asrEngine,
      cloudSttProvider: DEFAULT_SETTINGS.cloudSttProvider
    })
    expect(source.settings.brokerSpeech).toEqual(DEFAULT_BROKER_SPEECH_SETTINGS)
    expect(result).not.toBe(source.settings)
  })

  it.each([
    ['full package', { compiledPackageProfile: 'full' as const }],
    ['unknown compiled package', { compiledPackageProfile: null }],
    ['unverified package', { verifiedPackageProfile: null }],
    ['mismatched package marker', { verifiedPackageProfile: 'full' as const }],
    ['existing profile', { freshProfile: false }],
    ['unreadable authority policy', { authorityReadable: false }],
    ['explicit speech route', { speechRouteExplicit: true }]
  ])('preserves settings for %s', (_name, context) => {
    const source = input(context)
    expect(projectFreshLeanSpeechDefaults(source)).toEqual(source.settings)
  })

  it.each([
    ['completed onboarding', { onboardingDone: true }],
    ['selected legacy STT provider', { cloudSttProvider: 'soniox' as const }],
    [
      'managed cloud profile',
      { enterpriseLive: { managed: true, inferenceMode: 'cloud-only' as const, summaryOnly: false } }
    ]
  ])('preserves settings for %s', (_name, settingsOverrides) => {
    const source = input({}, settingsOverrides)
    expect(projectFreshLeanSpeechDefaults(source)).toEqual(source.settings)
  })

  it.each([
    ['managed broker key', { managedKeys: ['brokerSpeech'] }],
    ['locked broker key', { lockedKeys: ['brokerSpeech'] }]
  ])('preserves settings for %s', (_name, context) => {
    const source = input(context)
    expect(projectFreshLeanSpeechDefaults(source)).toEqual(source.settings)
  })

  it.each([
    { transport: 'broker-v1', engine: 'deepgram-nova3' },
    { transport: 'refused', engine: 'unconfigured', reason: 'INVALID_PROFILE' }
  ] as const)('does not replace an already chosen or refused broker profile', (brokerSpeech) => {
    const source = input({}, { brokerSpeech } as Settings)
    expect(projectFreshLeanSpeechDefaults(source)).toEqual(source.settings)
  })
})
