/** Public Operator client / console JS. Never Access. Never HTML. */

export const OPERATOR_CLIENT_JS = `'use strict';\nexport const metisOperatorClient = true;\n`

const JS_TYPE = 'application/javascript; charset=utf-8'
const JSON_TYPE = 'application/json; charset=utf-8'

export function isPublicAssetPath(pathname: string): boolean {
  return pathname === '/assets' || pathname.startsWith('/assets/')
}

export function publicAssetResponse(pathname: string): Response {
  if (pathname === '/assets/client.js') {
    return new Response(OPERATOR_CLIENT_JS, {
      status: 200,
      headers: {
        'content-type': JS_TYPE,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    })
  }
  return new Response(JSON.stringify({ ok: false, error: 'asset not found' }), {
    status: 404,
    headers: { 'content-type': JSON_TYPE, 'x-content-type-options': 'nosniff' }
  })
}
