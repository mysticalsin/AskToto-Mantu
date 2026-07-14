import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
