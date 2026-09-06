/**
 * Response helpers shared by every route. Every JSON and HTML response the Worker returns carries the
 * same baseline security headers: `no-store` so an intermediary or a shared machine never caches an
 * admin payload, `nosniff` so a browser never re-interprets a JSON body as script, `no-referrer` so the
 * console never leaks its own URL (which can carry a request id) to a third party, and `X-Frame-Options:
 * DENY` so the console can never be framed. HTML additionally carries a CSP; the inline script that ships
 * with `ui.ts` today needs a per-request nonce on its `<script>` tag to run under it (see `newCspNonce`).
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY'
})

/** Same headers as an object literal (not the frozen shared instance) for callers that want to mutate. */
export function noStoreHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS }
}

/** One CSP-safe random token per HTML render. Hex, not base64, so it is a clean CSP nonce and a clean HTML attribute. */
export function newCspNonce(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * CSP for the admin console. `script-src 'self'` covers the hashed bundle once the client build (P0.4)
 * lands; the inline script `ui.ts` still emits today needs its own nonce, so a nonce is always included
 * when one is minted. `style-src` keeps `unsafe-inline` because the console still emits inline `style="`
 * attributes; nothing else is a script-src exception.
 */
export function consoleCsp(nonce?: string): string {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'"
  ].join('; ')
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...noStoreHeaders() }
  })
}

export function html(body: string, opts: { nonce?: string } = {}): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': consoleCsp(opts.nonce),
      ...noStoreHeaders()
    }
  })
}
