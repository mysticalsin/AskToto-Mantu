import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface OverlayRendererUrlOptions {
  dirname: string
  devRendererUrl?: string
  onboardingLive: boolean
  postOnboardingDestination: 'answer' | 'settings'
  demo?: string
}

export interface DecoderRendererUrlOptions {
  dirname: string
  devRendererUrl?: string
}

export interface DecoderRendererUrl {
  url: string
  dev: boolean
  filePath: string
}

function rendererFileUrl(dirname: string, fileName: string): { url: string; filePath: string } {
  const filePath = join(dirname, '../renderer', fileName)
  return { url: pathToFileURL(filePath).toString(), filePath }
}

export function buildOverlayRendererUrl(options: OverlayRendererUrlOptions): string {
  const fallback = rendererFileUrl(options.dirname, 'index.html').url
  const params = new URLSearchParams()
  if (options.onboardingLive) params.set('exclusiveOnboarding', '1')
  if (!options.onboardingLive && options.postOnboardingDestination === 'settings') {
    params.set('view', 'settings')
    params.set('tab', 'ai')
  }
  if (options.demo) params.set('demo', options.demo)
  if (!params.size) return options.devRendererUrl ?? fallback

  const url = new URL(options.devRendererUrl ?? fallback)
  for (const [key, value] of params) url.searchParams.set(key, value)
  return url.href
}

export function buildDecoderRendererUrl(options: DecoderRendererUrlOptions): DecoderRendererUrl {
  const fallback = rendererFileUrl(options.dirname, 'decoder.html')
  if (options.devRendererUrl) {
    return { url: new URL('/decoder.html', options.devRendererUrl).toString(), dev: true, filePath: fallback.filePath }
  }
  return { url: fallback.url, dev: false, filePath: fallback.filePath }
}
