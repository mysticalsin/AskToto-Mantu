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

export function buildOverlayRendererUrl(options: OverlayRendererUrlOptions): string {
  const fallback = pathToFileURL(join(options.dirname, '../renderer/index.html')).href
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
  const filePath = join(options.dirname, '../renderer/decoder.html')
  if (options.devRendererUrl) {
    return { url: new URL('/decoder.html', options.devRendererUrl).toString(), dev: true, filePath }
  }
  return { url: pathToFileURL(filePath).toString(), dev: false, filePath }
}
