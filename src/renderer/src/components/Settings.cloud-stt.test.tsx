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
  it('CLOUD_ONLY shows Cloudflare Nova-3 as transcript source and hides on-device engines', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true },
      cloudSttProvider: 'unconfigured'
    })
    expect(html.includes('aria-label="Transcript source"')).toBe(true)
    expect(html.includes('Cloudflare Nova-3')).toBe(true)
    expect(html.includes('Soniox')).toBe(true)
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

  it('CLOUD_ONLY with Soniox selection stays cloud-labelled', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: false },
      cloudSttProvider: 'soniox'
    })
    expect(html.includes('aria-label="Transcript source"')).toBe(true)
    expect(html.includes('value="soniox"')).toBe(true)
  })

  it('CLOUD_ONLY Nova shows account id and gateway seat fields', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true },
      cloudSttProvider: 'cloudflare-nova3',
      cloudflareAccountId: '',
      cfAiGatewayId: ''
    })
    expect(html.includes('aria-label="Cloudflare account id for Nova"')).toBe(true)
    expect(html.includes('aria-label="CF AI Gateway id for Nova"')).toBe(true)
    expect(html.includes('—')).toBe(false)
  })

  it('CLOUD_ONLY Soniox shows Soniox key seat', () => {
    const html = renderSpeech({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: false },
      cloudSttProvider: 'soniox',
      hasKeys: { soniox: false }
    })
    expect(html.includes('aria-label="Soniox API key"')).toBe(true)
    expect(html.includes('Save Soniox key')).toBe(true)
    expect(html.includes('—')).toBe(false)
  })

})
