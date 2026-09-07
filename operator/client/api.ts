/**
 * Session + fetch helper. `ensureSession` mints a bearer via `GET /session` (Access sets the
 * cookie; the Worker mirrors it into `X-Metis-Session` so JSON fetches keep working through
 * Access-cookied cross-origin quirks). `api()` is the single call site every action uses.
 */

let sessionBearer = ''

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
