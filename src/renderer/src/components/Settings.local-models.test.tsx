import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, PublicSettingsSchema, type LocalModelSummary } from '@shared/ipc'
import { LocalAiSection } from './Settings'

const view = vi.hoisted(() => ({ models: null as LocalModelSummary[] | null }))
// Render the real card at the IPC boundary. Effects/network are outside this copy-and-controls test;
// useState(null) is the card's localModelsList result, while its other hooks and child components run.
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return { ...react, useLayoutEffect: react.useEffect, useState: (initial: unknown) => initial === null ? [view.models, vi.fn()] : react.useState(initial) }
})

const bundled: LocalModelSummary = {
  id: 'qwen3.5-0.8b', label: 'Qwen3.5 0.8B', minTotalRamGB: 8,
  source: 'bundled', ready: true, unavailableReason: null, downloadProgress: 0, downloadError: null
}
function renderModel(model: LocalModelSummary, enabled = false, others: LocalModelSummary[] = []): string {
  view.models = [model, ...others]
  const settings = PublicSettingsSchema.parse({
    ...DEFAULT_SETTINGS, hasApiKey: false, providerReady: false, visionReady: false, hasKeys: {},
    hasEncryption: true, resolvedMeetingsFolder: '',
    localLlm: { ...DEFAULT_SETTINGS.localLlm, enabled, modelId: model.id }
  })
  return renderToStaticMarkup(<LocalAiSection settings={settings} patch={() => {}} />)
}
afterEach(() => { view.models = null })
const hasRetryButton = (html: string): boolean => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
  .some((match) => match[1].replace(/<[^>]+>/g, '').trim() === 'Retry')

describe('MQA-319: Local AI shows installed availability and the right recovery action', () => {
  it('describes the included compact model and projector without opting the user in', () => {
    const html = renderModel(bundled)
    expect(html.includes('The installer includes Qwen3.5 0.8B and its screenshot projector')).toBe(true)
    expect(html).toContain('Included with Métis')
    expect(html).toContain('Available on this device. Local AI is off. Enable it to use this model.')
    expect(html).toContain('aria-label="Enable Métis Local"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain('not part of the installer')
    expect(hasRetryButton(html)).toBe(false)
  })

  it('shows repair/reinstall instead of download Retry for an invalid bundled payload', () => {
    const html = renderModel({ ...bundled, ready: false, unavailableReason: 'invalid-bundle', downloadError: 'Repair or reinstall Métis from the latest official installer.' })
    expect(html.includes('Repair or reinstall Métis from the latest official installer.')).toBe(true)
    expect(html).not.toContain('Could not download the on-device model:')
    expect(hasRetryButton(html)).toBe(false)
    expect(html).not.toContain('Not downloaded yet.')
  })

  it('still offers a requested 4B download without claiming its files are included', () => {
    const html = renderModel({ ...bundled, id: 'qwen3.5-4b', label: 'Qwen3.5 4B', source: 'download', ready: false, unavailableReason: 'not-downloaded' })
    expect(html.includes('The optional 4B model downloads only after selecting it and enabling Local AI or choosing Retry')).toBe(true)
    expect(html).toContain('Not downloaded yet. Enable Local AI to start, or select Retry to download without enabling it.')
    expect(hasRetryButton(html)).toBe(true)
    expect(html).not.toContain('Included with Métis.')
  })

  it('preserves optional download progress and network-retry guidance', () => {
    const downloading = renderModel({ ...bundled, source: 'download', ready: false, unavailableReason: 'downloading', downloadProgress: 0.42 })
    expect(downloading).toContain('Downloading the on-device model... 42%')
    expect(downloading).toContain('width:42%')
    const failed = renderModel({ ...bundled, source: 'download', ready: false, unavailableReason: 'download-failed' })
    expect(failed).toContain('huggingface.co')
    expect(failed).toContain('next launch while Local AI is enabled')
    expect(hasRetryButton(failed)).toBe(true)
  })

  it('does not let an unselected optional model error hide the usable included model', () => {
    const html = renderModel(bundled, false, [{
      ...bundled, id: 'qwen3.5-4b', label: 'Qwen3.5 4B', source: 'download', ready: false,
      unavailableReason: 'insufficient-disk', downloadError: 'Synthetic optional 4B disk shortage'
    }])
    expect(html.includes('Included with Métis.')).toBe(true)
    expect(html.includes('Synthetic optional 4B disk shortage')).toBe(false)
    expect(hasRetryButton(html)).toBe(false)
  })
})
