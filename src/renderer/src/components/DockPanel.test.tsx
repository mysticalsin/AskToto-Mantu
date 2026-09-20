import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DockPanel } from './DockPanel'
import type { BarProps } from './Bar'

/**
 * DockPanel.test.tsx
 *
 * The dock opens a 380x560 window. It used to render Bar into it, and Bar is an 880-wide horizontal
 * strip whose toolbar DESIGN.md pins as in-flow reserved boxes with overlap called a SHIP BLOCKER — so
 * the dock was shipping the exact overlap the contract forbids, with the answer crushed into a
 * letterbox. These render the real component (same idiom as Bar.test.tsx) and assert the properties
 * that make a narrow sidecar legible, rather than grepping its source.
 */
function props(overrides: Partial<BarProps> = {}): BarProps {
  return {
    value: '',
    onChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
    busy: false,
    listening: false,
    onToggleListen: () => {},
    paused: false,
    onTogglePause: () => {},
    onCapture: () => {},
    capturing: false,
    captureAccel: 'Cmd+Shift+1',
    onSettings: () => {},
    onHistory: () => {},
    onMinimize: () => {},
    stealth: false,
    onToggleStealth: () => {},
    startedAt: Date.now(),
    panelOpen: true,
    onTogglePanel: () => {},
    canTogglePanel: true,
    focusSignal: 0,
    mode: 'general',
    onSetMode: () => {},
    ...overrides
  }
}

describe('DockPanel — a sidecar, not a squeezed bar', () => {
  it('is a single vertical column that fills its window', () => {
    const html = renderToStaticMarkup(<DockPanel {...props()} />)
    expect(html).toContain('dock-panel')
    expect(html).toContain('flex-col')
    expect(html).toContain('h-full')
  })

  it('always offers the ask field and a send control, answer or not', () => {
    const empty = renderToStaticMarkup(<DockPanel {...props()} />)
    const answered = renderToStaticMarkup(
      <DockPanel {...props({ body: <p>an answer</p>, hasAnswer: true })} />
    )
    for (const html of [empty, answered]) {
      expect(html).toContain('aria-label="Ask Métis anything"')
      expect(html).toContain('aria-label="Ask"')
    }
  })

  it('never renders an empty void: with no answer it says what the panel is for', () => {
    const html = renderToStaticMarkup(<DockPanel {...props()} />)
    expect(html).toMatch(/Ask a question, capture the screen, or start a meeting/)
    const listening = renderToStaticMarkup(<DockPanel {...props({ listening: true })} />)
    expect(listening).toMatch(/Listening\. Ask anything about this meeting/)
  })

  it('gives a live meeting its own strip instead of wedging it between tool icons', () => {
    const html = renderToStaticMarkup(<DockPanel {...props({ listening: true })} />)
    expect(html).toContain('rec-dot')
    expect(html).toContain('aria-label="Stop meeting"')
    expect(html).toContain('aria-label="Pause"')
    // Start is gone while a meeting runs: one control, one meaning.
    expect(html).not.toContain('aria-label="Start meeting"')
  })

  it('offers Start only when idle', () => {
    const html = renderToStaticMarkup(<DockPanel {...props()} />)
    expect(html).toContain('aria-label="Start meeting"')
    expect(html).not.toContain('aria-label="Stop meeting"')
  })

  it('keeps every Bar capability reachable at 380 wide', () => {
    const html = renderToStaticMarkup(
      <DockPanel
        {...props({
          onSpotlightRef: () => {},
          onToggleThinking: () => {},
          body: <p>answer</p>,
          hasAnswer: true,
          onBack: () => {}
        })}
      />
    )
    for (const label of [
      'Capture screen',
      'Spotlight reference',
      'Mode:',
      'Deep thinking',
      'screen share',
      'Back'
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toMatch(/History|Transcript/)
  })

  it('offers Copy only when there is an answer to copy', () => {
    const none = renderToStaticMarkup(<DockPanel {...props()} />)
    expect(none).not.toContain('Copy answer')
    const some = renderToStaticMarkup(<DockPanel {...props({ body: <p>a</p>, hasAnswer: true })} />)
    expect(some).toContain('Copy answer')
  })

  it('offers New meeting only during a meeting, and only when the caller supports it', () => {
    const idle = renderToStaticMarkup(<DockPanel {...props({ onNewMeeting: () => {} })} />)
    expect(idle).not.toContain('New meeting')
    const live = renderToStaticMarkup(<DockPanel {...props({ listening: true, onNewMeeting: () => {} })} />)
    expect(live).toContain('New meeting')
    // No handler means no button, rather than a control that does nothing.
    const unsupported = renderToStaticMarkup(<DockPanel {...props({ listening: true })} />)
    expect(unsupported).not.toContain('New meeting')
  })

  it('the answer is the biggest zone and the only scroller', () => {
    const html = renderToStaticMarkup(<DockPanel {...props({ body: <p>answer</p>, hasAnswer: true })} />)
    expect(html).toContain('scroll-thin')
    // min-h-0 is load-bearing: without it a long answer pushes the composer out of a fixed-height window.
    expect(html).toContain('min-h-0')
    expect(html).toContain('flex-1')
  })

  it('stealth is stated in words, not just an icon, and respects its lock', () => {
    const on = renderToStaticMarkup(<DockPanel {...props({ stealth: true })} />)
    expect(on).toContain('Hidden from screen share')
    const off = renderToStaticMarkup(<DockPanel {...props({ stealth: false })} />)
    expect(off).toContain('Visible in screen share')
    const locked = renderToStaticMarkup(<DockPanel {...props({ stealthLocked: true })} />)
    expect(locked).toContain('disabled')
  })

  it('is drag-safe: every control opts out of the window drag region', () => {
    const html = renderToStaticMarkup(<DockPanel {...props({ listening: true })} />)
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(5)
    for (const b of buttons) expect(b).toContain('no-drag')
  })

  it('gives its contents an arrival, in zones, once', () => {
    const html = renderToStaticMarkup(<DockPanel {...props()} />)
    expect(html).toContain('dock-panel--entering')
    // Four zones: header, body, tools, composer. The cascade is declarative (CSS nth-child delays), so
    // there is no JS timer per zone to drift or leak.
    expect((html.match(/dock-zone/g) ?? []).length).toBe(4)
  })

  it('the live strip and the mode sheet animate as state changes, not as arrivals', () => {
    const live = renderToStaticMarkup(<DockPanel {...props({ listening: true })} />)
    expect(live).toContain('dock-strip')
    // The sheet is closed on first paint, so its class must not be present until it opens.
    expect(live).not.toContain('dock-sheet')
  })

  it('a new answer rises once, keyed by identity so a streaming token does not replay it', () => {
    const answered = renderToStaticMarkup(<DockPanel {...props({ body: <p>a</p>, hasAnswer: true })} />)
    expect(answered).toContain('dock-body-in')
  })

  it('every control carries an accessible name', () => {
    const html = renderToStaticMarkup(
      <DockPanel {...props({ onSpotlightRef: () => {}, onToggleThinking: () => {} })} />
    )
    // A name may come from aria-label/title OR from the button's own visible text (the History pill
    // names itself that way, which is a real accessible name, not a gap).
    const buttons = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
    expect(buttons.length).toBeGreaterThan(5)
    for (const [, attrs, inner] of buttons) {
      const named = /aria-label=|title=/.test(attrs) || inner.replace(/<[^>]*>/g, '').trim().length > 0
      expect(named, `unnamed control: <button${attrs}>`).toBe(true)
    }
  })
})
