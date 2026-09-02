/**
 * Operator reply contract for the Métis seat (heartbeat, Ask ingest, skill manifest).
 *
 * When Cloudflare Access wraps a device path on the Operator Worker, the edge answers a 302 to the
 * Access login page before the Worker runs. fetch's default `redirect: 'follow'` then lands a
 * 200 text/html sign-in page, and a lenient JSON parse turned that into a "successful" heartbeat.
 * Fetch with `redirect: 'manual'` and classify here. Pure. No I/O.
 */

export type OperatorReply =
  | { ok: true; json: unknown }
  | { ok: false; reason: 'access' | 'redirect' | 'html' | 'http' | 'not-json'; status: number; json: unknown }

const ACCESS_RE = /cloudflareaccess\.com|\/cdn-cgi\/access\//i

export function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text.replace(/^\uFEFF/, '').slice(0, 512))
}

export function classifyOperatorReply(input: {
  status: number
  contentType?: string | null
  location?: string | null
  text: string
}): OperatorReply {
  const { status, text } = input
  const location = input.location || ''
  const html = (input.contentType || '').toLowerCase().includes('text/html') || looksLikeHtml(text)
  if (status >= 300 && status < 400) {
    return { ok: false, reason: ACCESS_RE.test(location) ? 'access' : 'redirect', status, json: null }
  }
  if (html) {
    return { ok: false, reason: ACCESS_RE.test(text.slice(0, 8192)) ? 'access' : 'html', status, json: null }
  }
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not-json', status, json: null }
  }
  if (status < 200 || status >= 300) return { ok: false, reason: 'http', status, json }
  return { ok: true, json }
}

/** One log line per failure. Names the Access misconfiguration so the fix is obvious from the log. */
export function operatorReplyProblem(path: string, reply: Exclude<OperatorReply, { ok: true }>): string {
  switch (reply.reason) {
    case 'access':
      return `[operator] ${path} is behind Cloudflare Access (${reply.status} to the Access login). Device paths must bypass Access; see operator/README.md.`
    case 'redirect':
      return `[operator] ${path} redirected (${reply.status}). Redirects are never followed.`
    case 'html':
      return `[operator] ${path} answered HTML (${reply.status}), not JSON.`
    case 'not-json':
      return `[operator] ${path} answered ${reply.status} with a body that is not JSON.`
    default:
      return `[operator] ${path} ${reply.status}`
  }
}
