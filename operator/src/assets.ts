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
import { SECURITY_HEADERS } from './http'

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

/**
 * Minimal shape of the Cloudflare Workers Static Assets binding this file needs. Kept local
 * (same pattern as `D1DatabaseLike` in ./d1) rather than depending on `@cloudflare/workers-types`,
 * which this project's tsconfig does not pull in (`types: []`).
 */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

const BINARY_ASSET_PREFIXES = ['/assets/fonts/', '/assets/flags/', '/assets/logos/']

/** Fonts, flags and connector logos (plan D5, B8) -- served from the Workers Static Assets
 *  binding, not a hand-written Response like the hashed JS/CSS above. */
export function isBinaryAssetPath(pathname: string): boolean {
  return BINARY_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * operator/scripts/build-assets.mjs writes these files flat under
 * operator/public/{fonts,flags,logos}/ (verified by `ls operator/public/fonts` etc. in the P0.1
 * verification protocol), so the request's `/assets/` prefix is stripped before handing the
 * request to the binding -- `env.ASSETS.fetch` resolves a path relative to the configured
 * `directory` (`./public`), not the Worker's own `/assets/...` URL space. Immutable cache
 * control plus the Worker's existing baseline security headers are applied to whatever the
 * binding returns; an unmatched name gets the binding's own 404 straight through.
 */
export async function binaryAssetResponse(request: Request, env: { ASSETS?: AssetsBinding }): Promise<Response> {
  const url = new URL(request.url)
  if (!env.ASSETS) {
    return new Response('not found', { status: 404, headers: { ...SECURITY_HEADERS, ...headers('text/plain; charset=utf-8', 'no-store') } })
  }
  const rewritten = new URL(url.pathname.replace(/^\/assets/, ''), url.origin)
  const upstream = await env.ASSETS.fetch(new Request(rewritten, request))
  if (upstream.status === 404) {
    return new Response('not found', { status: 404, headers: { ...SECURITY_HEADERS, ...headers('text/plain; charset=utf-8', 'no-store') } })
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { ...SECURITY_HEADERS, ...headers(contentType, 'immutable') }
  })
}
