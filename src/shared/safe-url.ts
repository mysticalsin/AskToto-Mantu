/**
 * Allow-list for URLs that may become an href in the renderer (markdown, calendar join links).
 * javascript:/data:/file:/ms-msdt: must never be painted as links.
 */
const ALLOWED = /^(https?:|mailto:)/i

export function safeHref(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed || trimmed.length > 2048) return null
  if (trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return null
  if (!ALLOWED.test(trimmed)) return null
  try {
    if (trimmed.toLowerCase().startsWith('mailto:')) return trimmed
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}
