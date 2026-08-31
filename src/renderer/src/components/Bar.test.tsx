import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overlayAllowsMinimize } from '@shared/overlay-chrome'
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

describe('Bar minimize-to-circle is layout-gated', () => {
  it('shows the minimize control on bar and hides it on hide/island', () => {
    const bar = renderToStaticMarkup(<Bar {...props({ canMinimize: overlayAllowsMinimize('bar') })} />)
    const hide = renderToStaticMarkup(<Bar {...props({ canMinimize: overlayAllowsMinimize('hide') })} />)
    const island = renderToStaticMarkup(<Bar {...props({ canMinimize: overlayAllowsMinimize('island') })} />)
    expect(bar).toContain('Minimize to the orb')
    expect(hide).not.toContain('Minimize to the orb')
    expect(island).not.toContain('Minimize to the orb')
  })

  it('uses the listening thinking-orb on the docked 64 circle, not a second red disc', () => {
    const html = renderToStaticMarkup(
      <Bar {...props({ canMinimize: overlayAllowsMinimize('bar'), listening: true })} />
    )
    expect(html).toContain('data-bar-pill-orb')
    expect(html).toContain('data-orb-listening')
    expect(html).toContain('data-orb-state="listening"')
    expect(html).not.toContain('aw-orb__rec')
    expect(html).not.toContain('data-orb-mood="connecting"')
  })
})

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

describe('Bar Heard-live chip capture degradation', () => {
  // Tony 2026-07-20: a whole meeting ran mic-only (Screen Recording off) behind a chip that said
  // "Heard live" — the chip must stop claiming a side it isn't capturing.
  const note = 'System audio needs Screen Recording permission. Listening to microphone only; grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.'

  it('says Heard live only while nothing is degraded', () => {
    const html = renderToStaticMarkup(<Bar {...props({ listening: true })} />)
    expect(html).toContain('Heard live')
    expect(html).not.toContain('Mic only')
  })

  it('flips to Mic only with the full cause as tooltip when the them side is missing', () => {
    const html = renderToStaticMarkup(
      <Bar {...props({ listening: true, captureDegraded: { side: 'them', note, permission: true } })} />
    )
    expect(html).toContain('Mic only')
    expect(html).not.toContain('Heard live')
    expect(html).toContain('Screen Recording permission')
  })

  it('flips to No mic when the mic side is missing', () => {
    const html = renderToStaticMarkup(
      <Bar {...props({ listening: true, captureDegraded: { side: 'you', note: 'Microphone unavailable. Listening to system audio only.', permission: false } })} />
    )
    expect(html).toContain('No mic')
    expect(html).not.toContain('Heard live')
  })

  it('lets Paused win over the degraded state (an intentional pause is not a capture problem)', () => {
    const html = renderToStaticMarkup(
      <Bar {...props({ listening: true, paused: true, captureDegraded: { side: 'them', note, permission: true } })} />
    )
    expect(html).toContain('Paused')
    expect(html).not.toContain('Mic only')
  })
})

// MQA-036 (docs/qa/BUG-LEDGER.md): the eye button toggles `contentProtection` — whether OTHER people can
// see the Métis overlay in a screen share — but it was labelled "Private view", which is the name of a
// DIFFERENT setting (`privateView`, whether Métis can see YOUR screen), and its tooltip reported the
// inverse state. A user mid-screen-share clicked it believing it hid something and instead revealed the
// overlay to the whole call. The label must describe what the button actually does.
describe('Bar screen-share visibility control (MQA-036)', () => {
  it('never labels the contentProtection button with the other setting name "Private view"', () => {
    const hidden = renderToStaticMarkup(<Bar {...props({ stealth: true })} />)
    const visible = renderToStaticMarkup(<Bar {...props({ stealth: false })} />)
    const locked = renderToStaticMarkup(<Bar {...props({ stealth: true, stealthLocked: true })} />)

    for (const html of [hidden, visible, locked]) {
      expect(html.toLowerCase()).not.toContain('private view')
    }
  })

  it('states the CURRENT state and what clicking will do, in both directions', () => {
    const hidden = renderToStaticMarkup(<Bar {...props({ stealth: true })} />)
    expect(hidden).toContain('Hidden from screen share')
    expect(hidden).toContain('click to make Métis visible')

    const visible = renderToStaticMarkup(<Bar {...props({ stealth: false })} />)
    expect(visible).toContain('Visible in screen share')
    expect(visible).toContain('click to hide Métis')
  })
})
