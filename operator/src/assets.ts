import { SPA_CSS, SPA_CSS_PATH, SPA_JS, SPA_JS_PATH } from './spa/manifest'

/** Public chrome. Access must not wrap these. Worker must not 302 them. */

export { SPA_CSS_PATH, SPA_JS_PATH }

export function isPublicAssetPath(pathname: string): boolean {
  if (pathname === '/favicon.ico') return true
  return pathname === '/assets' || pathname.startsWith('/assets/')
}

function headers(type: string, immutable: boolean): HeadersInit {
  return {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=60'
  }
}

export function publicAssetResponse(pathname: string): Response | null {
  if (pathname === '/favicon.ico') {
    return new Response('', { status: 200, headers: headers('image/x-icon', false) })
  }
  if (pathname === SPA_JS_PATH) {
    return new Response(SPA_JS, {
      status: 200,
      headers: headers('application/javascript; charset=utf-8', true)
    })
  }
  if (pathname === SPA_CSS_PATH) {
    return new Response(SPA_CSS, {
      status: 200,
      headers: headers('text/css; charset=utf-8', true)
    })
  }
  return null
}
