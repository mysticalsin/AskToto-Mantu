import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildDecoderRendererUrl, buildOverlayRendererUrl } from './renderer-url'

function rendererFileExpectation(dirname: string, fileName: string): { url: string; filePath: string } {
  const filePath = join(dirname, '../renderer', fileName)
  return { url: pathToFileURL(filePath).toString(), filePath }
}

describe('renderer URL builders', () => {
  it('MQA-339 keeps packaged overlay navigation on file:// when the dev URL gate returns undefined', () => {
    const fallback = rendererFileExpectation('/app/main', 'index.html')
    expect(buildOverlayRendererUrl({
      dirname: '/app/main',
      devRendererUrl: undefined,
      onboardingLive: true,
      postOnboardingDestination: 'answer'
    })).toBe(`${fallback.url}?exclusiveOnboarding=1`)
  })

  it('MQA-339 still honors the dev renderer URL when the explicit dev gate supplies it', () => {
    expect(buildOverlayRendererUrl({
      dirname: '/app/main',
      devRendererUrl: 'http://127.0.0.1:5173/',
      onboardingLive: false,
      postOnboardingDestination: 'settings',
      demo: 'answer'
    })).toBe('http://127.0.0.1:5173/?view=settings&tab=ai&demo=answer')
  })

  it('MQA-339 keeps packaged decoder navigation on file:// when the dev URL gate returns undefined', () => {
    const fallback = rendererFileExpectation('/app/main', 'decoder.html')
    expect(buildDecoderRendererUrl({
      dirname: '/app/main',
      devRendererUrl: undefined
    })).toEqual({
      url: fallback.url,
      dev: false,
      filePath: fallback.filePath
    })
  })

  it('MQA-339 routes decoder navigation to Vite only when the explicit dev gate supplies it', () => {
    const fallback = rendererFileExpectation('/app/main', 'decoder.html')
    expect(buildDecoderRendererUrl({
      dirname: '/app/main',
      devRendererUrl: 'http://127.0.0.1:5173/app/'
    })).toEqual({
      url: 'http://127.0.0.1:5173/decoder.html',
      dev: true,
      filePath: fallback.filePath
    })
  })

  it('MQA-339 escapes packaged file URL characters the same way as pathToFileURL', () => {
    const packagedMainDir = '/Applications/Metis#beta.app/Contents/Resources/app.asar/out/main'
    const fallback = rendererFileExpectation(packagedMainDir, 'index.html')
    expect(buildOverlayRendererUrl({
      dirname: packagedMainDir,
      devRendererUrl: undefined,
      onboardingLive: false,
      postOnboardingDestination: 'answer'
    })).toBe(fallback.url)
    expect(fallback.url).toContain('Metis%23beta.app')
    expect(new URL(fallback.url).hash).toBe('')
  })
})
