import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema, type AsrAssetsStatus } from '@shared/ipc'
import { BUNDLE_NETWORK, BUNDLE_REPAIR } from '@shared/bundle-response'
import {
  CoreAsrAssetsRow,
  OFFICIAL_METIS_INSTALLER_URL,
  Settings,
  coreAsrAssetsView,
  readCoreAsrAssetsStatus,
  retryCoreAsrAssets
} from './Settings'

const ready: AsrAssetsStatus = {
  ready: true,
  status: 'ready',
  progress: 1,
  label: 'Transcription files ready'
}

function renderRow(status: AsrAssetsStatus | null): string {
  return renderToStaticMarkup(<CoreAsrAssetsRow initialStatus={status} />)
}

function renderSpeechSettings(): string {
  const settings = PublicSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    hasApiKey: false,
    providerReady: false,
    visionReady: false,
    hasKeys: {},
    hasEncryption: true,
    resolvedMeetingsFolder: ''
  })
  return renderToStaticMarkup(
    <Settings
      settings={settings}
      initialTab="audio"
      refreshSettings={async () => {}}
      patch={async () => settings}
      saveKey={async () => {}}
      recoverEncryptedProfile={async () => ({ ok: false })}
      clearKey={async () => {}}
      testKey={async () => ({ ok: true })}
    />
  )
}

beforeEach(() => vi.stubGlobal('window', { navigator: { platform: 'MacIntel' }, toto: {} }))
afterEach(() => vi.unstubAllGlobals())

describe('Settings core transcription assets', () => {
  it('places the recovery route in Settings → Speech', () => {
    const html = renderSpeechSettings()
    expect(html).toContain('Transcription files')
    expect(html).toContain('Checking transcription files…')
  })

  it('shows a checking state until Settings has a real snapshot', () => {
    expect(coreAsrAssetsView(null)).toEqual({ state: 'checking', detail: 'Checking transcription files…' })
    expect(renderRow(null)).toContain('Checking transcription files…')
  })

  it('renders a ready status without a recovery action', () => {
    const html = renderRow(ready)
    expect(coreAsrAssetsView(ready).state).toBe('ready')
    expect(html).toContain('Transcription files ready.')
    expect(html).not.toContain('Try again')
    expect(html).not.toContain('Open official installer')
  })

  it('shows progress for an in-flight setup started from onboarding', () => {
    const downloading: AsrAssetsStatus = {
      ready: false,
      status: 'downloading',
      progress: 0.42,
      label: 'Getting transcription files… (3/7)'
    }
    const html = renderRow(downloading)
    expect(coreAsrAssetsView(downloading)).toMatchObject({ state: 'downloading', progress: 0.42 })
    expect(html).toContain('aria-label="Transcription file download"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('width:42%')
  })

  it('offers Try again only for a retryable non-packaged failure', () => {
    const retryable: AsrAssetsStatus = {
      ready: false,
      status: 'error',
      progress: 0,
      label: BUNDLE_NETWORK,
      error: BUNDLE_NETWORK
    }
    expect(coreAsrAssetsView(retryable).state).toBe('retry')
    expect(renderRow(retryable)).toContain('Try again')
  })

  it('normalizes a failed retry into an actionable error instead of leaving a spinner', async () => {
    const ensure = vi.fn<() => Promise<AsrAssetsStatus>>().mockRejectedValue(new Error(BUNDLE_NETWORK))
    await expect(retryCoreAsrAssets(ensure)).resolves.toMatchObject({
      ready: false,
      status: 'error',
      error: BUNDLE_NETWORK
    })
    expect(ensure).toHaveBeenCalledOnce()
  })

  it('bounds a hung status read so Settings does not remain on Checking', async () => {
    const never = vi.fn<() => Promise<AsrAssetsStatus>>(() => new Promise<AsrAssetsStatus>(() => {}))
    await expect(readCoreAsrAssetsStatus(never, 0)).resolves.toMatchObject({
      ready: false,
      status: 'error',
      error: BUNDLE_NETWORK
    })
    expect(never).toHaveBeenCalledOnce()
  })

  it('shows installer repair for a damaged packaged payload and never renders Retry', () => {
    const packagedMissing: AsrAssetsStatus = {
      ready: false,
      status: 'error',
      progress: 0,
      label: BUNDLE_REPAIR,
      error: BUNDLE_REPAIR
    }
    const html = renderRow(packagedMissing)
    expect(coreAsrAssetsView(packagedMissing).state).toBe('repair')
    expect(html).toContain(BUNDLE_REPAIR)
    expect(html).toContain('Open official installer')
    expect(html).toContain(`href="${OFFICIAL_METIS_INSTALLER_URL}"`)
    expect(html).not.toContain('Try again')
  })
})
