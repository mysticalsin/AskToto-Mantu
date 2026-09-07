/**
 * Session + fetch helper. `ensureSession` mints a bearer via `GET /session` (Access sets the
 * cookie; the Worker mirrors it into `X-Metis-Session` so JSON fetches keep working through
 * Access-cookied cross-origin quirks). `api()` is the single call site every action uses.
 */

let sessionBearer = ''

/** True once a real Worker rendered this page: operator/src/ui.ts stamps `data-live-url` on
 *  `<html>` from operator/src/routes/admin-core.ts's `liveUrl`, and a standalone preview
 *  (operator/scripts/preview.mjs) never sets it, since there is truly nothing behind any
 *  `/v1/admin/*.json` route for that static file to reconnect to (same signal
 *  operator/client/live.ts's own `hasLiveEndpoint` already reads for the live-poll indicator).
 *  Shared here so every page module that hydrates itself from a JSON route after first paint
 *  can skip the doomed fetch and show an honest "preview only" state instead of a fetch-failed
 *  toast/error it can never recover from (task report findings 6-8: a permanently-stuck
 *  skeleton and a raw "network failed" string with no source, both artefacts of running the
 *  real client hydration path against a preview with no Worker behind it). Defaults to `true`
 *  (assume a real backend) when `document` itself is unavailable -- a non-browser test
 *  context, never the standalone preview this exists to detect. */
export function hasBackend(): boolean {
  try {
    return document.documentElement.hasAttribute('data-live-url')
  } catch {
    return true
  }
}

async function ensureSession(): Promise<void> {
  if (sessionBearer) return
  try {
    var ping = await fetch('/session', {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' }
    })
    var issued = ping.headers && ping.headers.get && ping.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
    var pingText = await ping.text()
    try {
      var pingJson = JSON.parse(pingText)
      if (pingJson && pingJson.session) sessionBearer = pingJson.session
    } catch (e) {}
  } catch (e) {}
}

export function looksLikeAccessHtml(text: string): boolean {
  var t = String(text || '').toLowerCase()
  return t.indexOf('<!doctype') >= 0 || t.indexOf('<html') >= 0 || t.indexOf('cf-access') >= 0
}

export async function api(path: string, body?: unknown): Promise<any> {
  await ensureSession()
  var r: Response
  var headers: Record<string, string> = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (sessionBearer) headers.authorization = 'Bearer ' + sessionBearer
  try {
    r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    return { ok: false, error: 'network failed' }
  }
  try {
    var issued = r.headers && r.headers.get && r.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
  } catch (e) {}
  var text = await r.text()
  try {
    return JSON.parse(text)
  } catch (e) {
    if (!text || looksLikeAccessHtml(text)) {
      return { ok: false, error: 'Access required. Sign in with Cloudflare Access and retry Add.' }
    }
    return { ok: false, error: text.slice(0, 180) || 'HTTP ' + r.status }
  }
}
