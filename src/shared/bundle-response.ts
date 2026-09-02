/**
 * Bundle download contract: Operator / Parakeet / Whisper / client JS.
 *
 * Cloudflare Access 302s `/assets/*` (and other files) through a login HTML page. Electron `net.fetch`
 * often follows that hop and returns HTTP 200 + `text/html`. Treating those bytes as a successful
 * `.js` / `.onnx` / archive write is how login dies silent. Fail loud. Never adopt HTML.
 */

export const BUNDLE_NETWORK =
  'Could not get the files. Check your connection and try again.'

export const BUNDLE_GOT_LOGIN_HTML =
  'Could not get the files. The download was a login page, not the real files. Try again.'

export const BUNDLE_NOT_JS =
  'Could not get the script. The download was not JavaScript. Try again.'

export const BUNDLE_DISK = 'Could not save the files. Check disk space and try again.'

export type BundleKind = 'js' | 'wasm' | 'onnx' | 'archive' | 'json' | 'binary'

export type BundleInspectOk = { ok: true }
export type BundleInspectFail = { ok: false; message: string }
export type BundleInspect = BundleInspectOk | BundleInspectFail

const ACCESS_RE =
  /cloudflareaccess|cf-access-jwt|cf_app_session|access\.cloudflare|cf-access/i

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  const ct = (contentType || '').toLowerCase()
  return ct.includes('text/html') || ct.includes('application/xhtml')
}

export function isJavascriptContentType(contentType: string | null | undefined): boolean {
  const ct = (contentType || '').toLowerCase()
  return (
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('text/js') ||
    ct === 'application/wasm'
  )
}

export function looksLikeAccessLoginHtml(text: string): boolean {
  const t = text.slice(0, 8192)
  if (ACCESS_RE.test(t)) return true
  if (/<html[\s>]|<!doctype html/i.test(t) && /sign\s*in|log[\s-]?in|challenge-form|cloudflare/i.test(t)) {
    return true
  }
  return false
}

export function looksLikeHtml(text: string): boolean {
  const t = text.replace(/^\uFEFF/, '').trimStart().slice(0, 512)
  return /^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(t)
}

export function looksLikeHtmlBytes(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 512)
  if (n === 0) return false
  const chars: number[] = []
  for (let i = 0; i < n; i++) {
    const c = buf[i]
    if (c === 0) return false
    chars.push(c)
  }
  const text = String.fromCharCode(...chars)
  return looksLikeHtml(text) || looksLikeAccessLoginHtml(text)
}

export function looksLikeAccessRedirect(location: string | null | undefined): boolean {
  return ACCESS_RE.test(location || '')
}

export function inspectBundleResponse(input: {
  status: number
  contentType?: string | null
  bodyPrefix?: string
  location?: string | null
  expected?: BundleKind
}): BundleInspect {
  const status = input.status
  const location = input.location || ''
  const prefix = input.bodyPrefix || ''
  const expected = input.expected

  if (status >= 300 && status < 400) {
    if (looksLikeAccessRedirect(location) || looksLikeAccessLoginHtml(prefix)) {
      return { ok: false, message: BUNDLE_GOT_LOGIN_HTML }
    }
    return { ok: false, message: BUNDLE_NETWORK }
  }
  if (status === 0 || !Number.isFinite(status)) {
    return { ok: false, message: BUNDLE_NETWORK }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, message: BUNDLE_NETWORK }
  }

  if (isHtmlContentType(input.contentType) || looksLikeHtml(prefix) || looksLikeAccessLoginHtml(prefix)) {
    return { ok: false, message: BUNDLE_GOT_LOGIN_HTML }
  }

  if (expected === 'js') {
    if (isHtmlContentType(input.contentType) || looksLikeHtml(prefix)) {
      return { ok: false, message: BUNDLE_NOT_JS }
    }
    const ct = (input.contentType || '').toLowerCase()
    if (ct && !isJavascriptContentType(input.contentType) && (ct.includes('json') || ct.includes('text/plain'))) {
      if (prefix.trimStart().startsWith('{') || prefix.trimStart().startsWith('<')) {
        return { ok: false, message: BUNDLE_NOT_JS }
      }
    }
  }

  return { ok: true }
}

export function bundleKindForUrl(url: string): BundleKind {
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'js'
  if (path.endsWith('.wasm')) return 'wasm'
  if (path.endsWith('.onnx')) return 'onnx'
  if (path.endsWith('.json')) return 'json'
  if (/\.(tar\.bz2|tar\.gz|tgz|bz2|tar)$/.test(path)) return 'archive'
  return 'binary'
}

export function bundleFailureUserMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const trimmed = raw.trim()
  if (!trimmed) return BUNDLE_NETWORK
  if (/reinstall/i.test(trimmed)) return BUNDLE_NETWORK
  if (
    trimmed === BUNDLE_GOT_LOGIN_HTML ||
    trimmed === BUNDLE_NOT_JS ||
    trimmed === BUNDLE_NETWORK ||
    trimmed === BUNDLE_DISK
  ) {
    return trimmed
  }
  if (/transcription files/i.test(trimmed) && /try again|could not/i.test(trimmed)) return trimmed
  if (looksLikeAccessLoginHtml(trimmed) || /login page|text\/html|cloudflareaccess|cf-access/i.test(trimmed)) {
    return BUNDLE_GOT_LOGIN_HTML
  }
  if (/not javascript|not a script|HTTP not JS/i.test(trimmed)) return BUNDLE_NOT_JS
  if (/ENOSPC|no space|disk space|EACCES|EPERM|EROFS/i.test(trimmed)) return BUNDLE_DISK
  if (/HTTP \d+|network|fetch|ENOTFOUND|ECONN|ETIMEDOUT|timeout|abort|offline|socket|dns/i.test(trimmed)) {
    return BUNDLE_NETWORK
  }
  return trimmed
}

export function isRetryableBundleMessage(detail: string | null | undefined): boolean {
  return /could not|try again|check your connection|login page|not javascript|not a script|disk space|access/i.test(
    detail ?? ''
  )
}
