import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema, type PublicSettings } from '@shared/ipc'
import { asrImportModelDescription, Settings, WhisperQualityRow } from './Settings'
import { asrAssetsRowStatus } from './OnboardingExperience'

// Browser permission effects are outside this render-only copy/control test. Layout scheduling is
// likewise irrelevant to server rendering; leave all production components and their markup real.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useLayoutEffect: react.useEffect }
})

function renderSpeech(patch: Partial<PublicSettings> = {}): string {
  const settings = PublicSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    hasApiKey: false,
    providerReady: false,
    visionReady: false,
    hasKeys: {},
    hasEncryption: true,
    resolvedMeetingsFolder: '',
    ...patch
  })
  return renderToStaticMarkup(
    <Settings
      settings={settings}
      initialTab="audio"
      refreshSettings={async () => {}}
      patch={() => {}}
      saveKey={async () => {}}
      recoverEncryptedProfile={async () => ({ ok: false })}
      clearKey={async () => {}}
      testKey={async () => ({ ok: true })}
    />
  )
}

beforeEach(() => vi.stubGlobal('window', { navigator: { platform: 'MacIntel' } }))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('MQA-311: Speech controls describe the model the runtime can actually use', () => {
  it.each(['best', 'fast'] as const)('does not offer a no-op packaged quality switch for %s', (asrQuality) => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    const html = renderSpeech({ asrEngine: 'whisper', asrQuality })
    expect(html.includes('aria-label="Best transcription quality"')).toBe(false)
    expect(html.includes('aria-label="Prefer large live Whisper (development)"')).toBe(false)
    expect(html.includes('Live Whisper uses the compact Whisper base model')).toBe(true)
  })

  it('describes both fresh-setup RAM choices instead of claiming one universal default', () => {
    const html = renderSpeech()
    expect(/8 GB or less[^<]*Parakeet/.test(html)).toBe(true)
    expect(/more than 8 GB[^<]*Whisper/.test(html)).toBe(true)
    expect(html.includes('Parakeet is the default')).toBe(false)
  })

  it('does not tell a packaged user that an import-model download upgrades live transcription', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('DEV', false)
    const html = renderSpeech({ asrEngine: 'whisper', asrWebgpuFallbackAt: 1_700_000_000_000 })
    expect(html.includes('The optional larger model applies to imported recordings, not live transcription')).toBe(true)
    expect(html.includes('Download the high-accuracy model below')).toBe(false)
    expect(html.includes('Download the high-accuracy model to restore Best')).toBe(false)
  })

  it.each([true, false, null, undefined])('never exposes development controls in production, even with probe %s', (bundled) => {
    vi.stubEnv('PROD', true)
    const html = renderToStaticMarkup(
      <WhisperQualityRow bundled={bundled} settings={{ asrEngine: 'whisper', asrQuality: 'best', managedKeys: [] }} patch={() => {}} />
    )
    expect(html.includes('role="switch"')).toBe(false)
  })

  it('retains the large-model preference only for unbundled development Whisper', () => {
    vi.stubEnv('PROD', false)
    const html = renderToStaticMarkup(
      <WhisperQualityRow bundled={false} settings={{ asrEngine: 'whisper', asrQuality: 'best', managedKeys: [] }} patch={() => {}} />
    )
    expect(html.includes('role="switch"')).toBe(true)
    expect(html.includes('aria-label="Prefer large live Whisper (development)"')).toBe(true)
    expect(html.includes('aria-checked="true"')).toBe(true)
  })

  it.each(['parakeet', 'apple'] as const)('does not offer the Whisper preference when %s is selected', (asrEngine) => {
    vi.stubEnv('PROD', false)
    const html = renderToStaticMarkup(
      <WhisperQualityRow bundled={false} settings={{ asrEngine, asrQuality: 'best', managedKeys: [] }} patch={() => {}} />
    )
    expect(html.includes('role="switch"')).toBe(false)
    expect(html.includes('Live Whisper uses')).toBe(false)
  })

  it('distinguishes an installed import model from the selected Parakeet engine', () => {
    const copy = asrImportModelDescription({ status: 'ready', ready: true, progress: 1, bytes: 1_610_000_000 }, 'parakeet')
    expect(copy).toContain('import model installed (1.61 GB)')
    expect(copy).toContain('imports still use Parakeet')
    expect(copy).toContain('does not upgrade live transcription')
  })

  it.each(['whisper', 'apple'] as const)('offers the optional import model for %s without promising a live upgrade', (engine) => {
    const copy = asrImportModelDescription({ status: 'idle', ready: false, progress: 0, bytes: 1_610_000_000 }, engine)
    expect(copy).toContain('1.61 GB download')
    expect(copy).toContain('Whisper imports use the compact base model until it is available')
    expect(copy).toContain('does not upgrade live transcription')
    expect(copy).not.toContain('model installed')
  })

  it('shows transfer progress without calling the larger import model installed', () => {
    const copy = asrImportModelDescription({ status: 'downloading', ready: false, progress: 0.42, bytes: 1_610_000_000 }, 'whisper')
    expect(copy).toContain('imported recordings: 42% of 1.61 GB')
    expect(copy).not.toContain('installed')
  })

  it.each([
    ['parakeet', 'Parakeet'],
    ['whisper', 'Whisper base'],
    ['apple', 'Apple Speech']
  ] as const)('onboarding reports the selected %s engine without claiming the larger model', (engine, label) => {
    const copy = asrAssetsRowStatus({ status: 'ready', ready: true, progress: 1, label: 'Ready' }, engine)
    expect(copy.state).toBe('ready')
    expect(copy.detail).toContain('Whisper base files ready')
    expect(copy.detail).toContain(`Selected for live meetings: ${label}`)
    expect(copy.detail).not.toContain('large')
  })
})
