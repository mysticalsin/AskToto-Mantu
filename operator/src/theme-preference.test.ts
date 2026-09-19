import { describe, expect, it } from 'vitest'
import {
  isFreshLiveEvent,
  LIVE_EVENTS_WINDOW_MS,
  readThemeCookie,
  resolveMapTheme
} from './theme-preference'

describe('resolveMapTheme', () => {
  it('keeps explicit light', () => {
    expect(resolveMapTheme('light')).toBe('light')
  })

  it('paints dark for dark and system (never force light on Realtime SSR)', () => {
    expect(resolveMapTheme('dark')).toBe('dark')
    expect(resolveMapTheme('system')).toBe('dark')
  })
})

describe('readThemeCookie', () => {
  it('reads metis-operator-theme from Cookie', () => {
    const req = new Request('https://example.test/', {
      headers: { cookie: 'other=1; metis-operator-theme=dark; x=y' }
    })
    expect(readThemeCookie(req)).toBe('dark')
  })

  it('defaults to system when cookie missing', () => {
    expect(readThemeCookie(new Request('https://example.test/'))).toBe('system')
  })

  it('fails closed to system when the theme cookie has malformed percent encoding', () => {
    const req = new Request('https://example.test/', {
      headers: { cookie: 'metis-operator-theme=%E0%A4%A' }
    })
    expect(readThemeCookie(req)).toBe('system')
  })
})

describe('isFreshLiveEvent', () => {
  const now = 1_725_000_000_000

  it('accepts events inside the 30m live window', () => {
    expect(isFreshLiveEvent(now - 60_000, now)).toBe(true)
    expect(isFreshLiveEvent(now, now)).toBe(true)
  })

  it('rejects stale ages like 36h so LIVE EVENTS never shows them', () => {
    expect(isFreshLiveEvent(now - 36 * 60 * 60 * 1000, now)).toBe(false)
    expect(isFreshLiveEvent(now - LIVE_EVENTS_WINDOW_MS - 1, now)).toBe(false)
  })
})
