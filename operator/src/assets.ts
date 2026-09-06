import {
  SPA_CSS,
  SPA_CSS_PATH,
  SPA_INDEX_JS_PATH,
  SPA_JS,
  SPA_JS_PATH,
  SPA_WORLD_INDEX_PATH,
  SPA_WORLD_SVG,
  SPA_WORLD_SVG_PATH
} from './spa/manifest'

/** Public chrome. Access must not wrap these. Worker must not 302 them. */

export { SPA_CSS_PATH, SPA_INDEX_JS_PATH, SPA_JS_PATH, SPA_WORLD_INDEX_PATH, SPA_WORLD_SVG_PATH }

export function isPublicAssetPath(pathname: string): boolean {
  if (pathname === '/favicon.ico') return true
  return pathname === '/assets' || pathname.startsWith('/assets/')
}

type CacheMode = 'immutable' | 'short' | 'no-store'

/** Hashed filenames never change content, so they cache for a year. The unhashed
 * /assets/index.js alias is curled by Ultron/QA for the latest chrome and must never be
 * cached (no-store), since its content changes on every deploy without a URL change. */
function headers(type: string, mode: CacheMode): HeadersInit {
  const cacheControl =
    mode === 'immutable' ? 'public, max-age=31536000, immutable' : mode === 'no-store' ? 'no-store' : 'public, max-age=60'
  return {
    'content-type': type,
    'cache-control': cacheControl
  }
}

export function publicAssetResponse(pathname: string): Response | null {
  if (pathname === '/favicon.ico') {
    return new Response('', { status: 200, headers: headers('image/x-icon', 'short') })
  }
  if (pathname === SPA_JS_PATH || pathname === SPA_INDEX_JS_PATH) {
    return new Response(SPA_JS, {
      status: 200,
      headers: headers('application/javascript; charset=utf-8', pathname === SPA_JS_PATH ? 'immutable' : 'no-store')
    })
  }
  if (pathname === SPA_CSS_PATH) {
    return new Response(SPA_CSS, {
      status: 200,
      headers: headers('text/css; charset=utf-8', 'immutable')
    })
  }
  if (pathname === SPA_WORLD_SVG_PATH || pathname === SPA_WORLD_INDEX_PATH) {
    return new Response(SPA_WORLD_SVG, {
      status: 200,
      headers: headers('image/svg+xml; charset=utf-8', pathname === SPA_WORLD_SVG_PATH ? 'immutable' : 'short')
    })
  }
  return null
}
