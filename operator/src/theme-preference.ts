/**
 * Console theme preference (cookie + theme resolution helpers).
 * The realtime map no longer bakes a theme into its SSR markup: land, ocean and pills read the
 * --map-* CSS tokens, so they follow `data-theme` (or prefers-color-scheme when it is absent)
 * without a repaint. `resolveMapTheme` stays for callers that still need a concrete light/dark.
 */

export type ThemePreference = 'light' | 'dark' | 'system'

export const THEME_COOKIE = 'metis-operator-theme'

/** Map land/ocean paint: only explicit light stays light. Dark and system both paint dark. */
export function resolveMapTheme(theme: ThemePreference): 'light' | 'dark' {
  return theme === 'light' ? 'light' : 'dark'
}

export function readThemeCookie(request: Request): ThemePreference {
  const raw = request.headers.get('cookie') || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k !== THEME_COOKIE) continue
    let v: string
    try {
      v = decodeURIComponent(rest.join('=').trim())
    } catch {
      return 'system'
    }
    if (v === 'light' || v === 'dark' || v === 'system') return v
  }
  return 'system'
}

/** LIVE EVENTS strip window: heartbeats older than this stay on Events, not the live feed. */
export const LIVE_EVENTS_WINDOW_MS = 30 * 60 * 1000

export function isFreshLiveEvent(ts: number, now: number, windowMs = LIVE_EVENTS_WINDOW_MS): boolean {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false
  const age = now - ts
  return age >= 0 && age <= windowMs
}
