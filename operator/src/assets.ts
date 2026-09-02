/** Public chrome. Access must not wrap these. Worker must not 302 them. */

export const ASSET_INDEX_PATH = '/assets/index.js'

export const ASSET_INDEX_JS = `/* Métis Operator chrome */
self.METIS_OPERATOR = self.METIS_OPERATOR || { asset: 'index.js' };
`

export const ASSET_INDEX_CSS = `/* Métis Operator chrome */\n:root{--metis-operator:1}\n`

export function isPublicAssetPath(pathname: string): boolean {
  if (pathname === '/favicon.ico') return true
  return pathname === '/assets' || pathname.startsWith('/assets/')
}

function contentTypeFor(pathname: string): string {
  if (pathname === '/favicon.ico') return 'image/x-icon'
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8'
  return 'application/javascript; charset=utf-8'
}

export function publicAssetResponse(pathname: string): Response | null {
  if (!isPublicAssetPath(pathname)) return null
  const type = contentTypeFor(pathname)
  const body =
    pathname === '/favicon.ico'
      ? ''
      : pathname.endsWith('.css')
        ? ASSET_INDEX_CSS
        : ASSET_INDEX_JS
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=60'
    }
  })
}
