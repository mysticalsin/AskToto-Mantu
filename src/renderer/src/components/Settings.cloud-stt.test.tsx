import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema, type PublicSettings } from '@shared/ipc'
import { Settings } from './Settings'

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
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('enterprise-live Speech: cloud transcript source', () => {
  it('CLOUD_ONLY hides direct provider credentials and on-device engines', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true },
      cloudSttProvider: 'unconfigured'
    })
    expect(html.includes('aria-label="Transcript source"')).toBe(false)
    expect(html.includes('Cloudflare account id for Nova')).toBe(false)
    expect(html.includes('CF AI Gateway id for Nova')).toBe(false)
    expect(html.includes('Soniox API key')).toBe(false)
    expect(html.includes('approved hosted speech route')).toBe(true)
    expect(html.includes('aria-label="Transcription engine"')).toBe(false)
    expect(html.includes('Parakeet · European languages')).toBe(false)
    expect(html.includes('—')).toBe(false)
  })

  it('legacy profile keeps on-device transcription engine select', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false }
    })
    expect(html.includes('aria-label="Transcription engine"')).toBe(true)
    expect(html.includes('Parakeet · European languages')).toBe(true)
    expect(html.includes('aria-label="Transcript source"')).toBe(false)
  })

  it('managed legacy profiles do not show direct provider key controls', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'legacy', summaryOnly: false },
      cloudSttProvider: 'soniox',
      hasKeys: { soniox: true }
    })
    expect(html.includes('aria-label="Transcript source"')).toBe(false)
    expect(html.includes('Cloudflare account id for Nova')).toBe(false)
    expect(html.includes('CF AI Gateway id for Nova')).toBe(false)
    expect(html.includes('Soniox API key')).toBe(false)
    expect(html.includes('approved hosted speech route')).toBe(true)
    expect(html.includes('—')).toBe(false)
  })
})
