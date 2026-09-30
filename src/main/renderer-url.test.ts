import { describe, expect, it } from 'vitest'
import { buildDecoderRendererUrl, buildOverlayRendererUrl } from './renderer-url'

describe('renderer URL builders', () => {
  it('MQA-339 keeps packaged overlay navigation on file:// when the dev URL gate returns undefined', () => {
    expect(buildOverlayRendererUrl({
      dirname: '/app/main',
      devRendererUrl: undefined,
      onboardingLive: true,
      postOnboardingDestination: 'answer'
    })).toBe('file:///app/renderer/index.html?exclusiveOnboarding=1')
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
    expect(buildDecoderRendererUrl({
      dirname: '/app/main',
      devRendererUrl: undefined
    })).toEqual({
      url: 'file:///app/renderer/decoder.html',
      dev: false,
      filePath: '/app/renderer/decoder.html'
    })
  })

  it('MQA-339 routes decoder navigation to Vite only when the explicit dev gate supplies it', () => {
    expect(buildDecoderRendererUrl({
      dirname: '/app/main',
      devRendererUrl: 'http://127.0.0.1:5173/app/'
    })).toEqual({
      url: 'http://127.0.0.1:5173/decoder.html',
      dev: true,
      filePath: '/app/renderer/decoder.html'
    })
  })
})
