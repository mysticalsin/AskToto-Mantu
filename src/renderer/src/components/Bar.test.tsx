import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bar, type BarProps } from './Bar'

function props(overrides: Partial<BarProps> = {}): BarProps {
  return {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    busy: false,
    listening: false,
    onToggleListen: vi.fn(),
    paused: false,
    onTogglePause: vi.fn(),
    onCapture: vi.fn(),
    capturing: false,
    onSettings: vi.fn(),
    onHistory: vi.fn(),
    onMinimize: vi.fn(),
    stealth: true,
    onToggleStealth: vi.fn(),
    startedAt: 0,
    panelOpen: false,
    onTogglePanel: vi.fn(),
    canTogglePanel: false,
    focusSignal: 0,
    mode: 'general',
    onSetMode: vi.fn(),
    onSpotlightRef: vi.fn(),
    ...overrides
  }
}

describe('Bar Spotlight Ref control', () => {
  it('keeps Spotlight Ref discoverable when Dust is not configured', () => {
    const html = renderToStaticMarkup(<Bar {...props({ spotlightReady: false })} />)

    expect(html).toContain('aria-label="Spotlight Ref · Connect Dust in Settings"')
  })

  it('uses the concise Spotlight Ref label when Dust is ready', () => {
    const html = renderToStaticMarkup(<Bar {...props({ spotlightReady: true })} />)

    expect(html).toContain('aria-label="Spotlight Ref"')
  })
})

describe('Bar screen-freshness chip', () => {
  // The chip derives its age from capturedAt + Date.now() at render time (no fake-timer tick needed
  // for a static render) — vi.setSystemTime just pins "now" so elapsed is deterministic here.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is visible under 60s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const html = renderToStaticMarkup(<Bar {...props({ screenCapturedAt: 1_000_000 - 59_000 })} />)

    expect(html).toContain('Seen 59s ago')
  })

  it('is gone once the capture is older than 60s', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const html = renderToStaticMarkup(<Bar {...props({ screenCapturedAt: 1_000_000 - 61_000 })} />)

    expect(html).not.toContain('Seen')
  })

  it('returns the instant a fresh capture lands', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const stale = renderToStaticMarkup(<Bar {...props({ screenCapturedAt: 1_000_000 - 61_000 })} />)
    expect(stale).not.toContain('Seen')

    const fresh = renderToStaticMarkup(<Bar {...props({ screenCapturedAt: 1_000_000 })} />)
    expect(fresh).toContain('Seen now')
  })
})
