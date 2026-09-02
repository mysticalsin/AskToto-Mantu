import { CONSOLE_CSS } from './css'
import { CONSOLE_JS } from './client'

const MIN_SPA_BYTES = 2000

/** Content hash for immutable /assets/operator-<hash>.(js|css) names. */
export function contentHash(body: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619)
    b = Math.imul(b + c, 2246822519) ^ (a >>> 7)
  }
  return ((a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')).slice(0, 12)
}

export const SPA_JS = CONSOLE_JS
export const SPA_CSS = CONSOLE_CSS

if (SPA_JS.length < MIN_SPA_BYTES || SPA_CSS.length < MIN_SPA_BYTES) {
  throw new Error(
    `Métis Operator refused to ship a stub SPA (js=${SPA_JS.length} css=${SPA_CSS.length})`
  )
}
if (SPA_JS.includes('self.METIS_OPERATOR =') && SPA_JS.length < 500) {
  throw new Error('Métis Operator refused to ship METIS_OPERATOR stub')
}

export const SPA_JS_HASH = contentHash(SPA_JS)
export const SPA_CSS_HASH = contentHash(SPA_CSS)
export const SPA_JS_NAME = `operator-${SPA_JS_HASH}.js`
export const SPA_CSS_NAME = `operator-${SPA_CSS_HASH}.css`
export const SPA_JS_PATH = `/assets/${SPA_JS_NAME}`
export const SPA_CSS_PATH = `/assets/${SPA_CSS_NAME}`
