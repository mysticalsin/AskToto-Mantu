import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bar, answerBodyMaxHeight, type BarProps } from './Bar'

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
    captureAccel: 'Alt+Shift+S',
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

/** The shipped `.aw-body` element's own opening tag (its attributes, nothing else) as rendered on a
 *  display of `availHeight` — i.e. exactly what caps the answer surface in the real app. */
function renderedBodyTag(availHeight: number): string {
  vi.stubGlobal('window', { screen: { availHeight } })
  const html = renderToStaticMarkup(
    <Bar {...props({ body: <p>a long answer</p>, hasAnswer: true })} />
  )
  const at = html.indexOf('aw-body')
  expect(at).toBeGreaterThan(-1)
  return html.slice(at, html.indexOf('>', at))
}

/** Mirrors the real height feedback loop the answer surface lives inside:
 *  useAutoResize measures the content root, quantizes the GROW path onto a 24px grid
 *  (`Math.ceil((height + 2) / 24) * 24`, state.ts) and pushes it over IPC; main's `resizeTo`
 *  clamps to `[BAR_MIN_HEIGHT, workArea.height - 48]` (index.ts) and calls setBounds. The new
 *  window height IS the renderer's viewport, so any cap expressed in `vh` is re-evaluated
 *  against the height it just produced — that is the circularity under test. */
function settle(
  bodyCap: (windowHeight: number) => number,
  opts: { availHeight: number; contentHeight: number }
): { height: number; steps: number } {
  const CHROME = 86 // BAR_HEIGHT (84) + the +2 useAutoResize adds — the non-body part of the window
  let h = 84 // the idle bar, before any answer renders
  let steps = 0
  for (let i = 0; i < 50; i++) {
    const body = Math.min(opts.contentHeight, bodyCap(h))
    const measured = Math.ceil((CHROME + body + 2) / 24) * 24
    const next = Math.max(44, Math.min(measured, opts.availHeight - 48))
    if (next === h) break
    h = next
    steps++
  }
  return { height: h, steps }
}

const LAPTOP = 728 // 1366x768 work area
const RETINA = 2100 // 3840x2160 work area

afterEach(() => {
  vi.unstubAllGlobals()
})

// MQA-198 (docs/qa/BUG-LEDGER.md): the in-bar answer surface capped itself with `max-h-[76vh]`, but the
// overlay window is CONTENT-sized — the renderer measures the content and asks main to resize the window
// to it — so `vh` resolved against a viewport this cap was itself producing. H = chrome + 0.76·H has a
// fixed point at chrome/0.24, so the window ratcheted to ~360-384px and stopped there on a 4K monitor and
// on a 1366x768 laptop alike, giving the same ~275px of readable answer on every display, while the
// sibling Panel surface (Panel.tsx) correctly grows with the screen.
describe('Bar answer-body height cap (MQA-198)', () => {
  it('never caps the answer body against its own viewport', () => {
    const body = renderedBodyTag(RETINA)

    // `vh` (or any other viewport unit) here is the defect itself: the window's height is derived from
    // this element's height, so a viewport-relative cap is a function of its own output.
    expect(body).not.toContain('vh')
    expect(body).toMatch(/max-height:\d+px/)
  })

  it('scales the readable area with the display it is on', () => {
    const laptop = renderedBodyTag(LAPTOP)
    const retina = renderedBodyTag(RETINA)

    const px = (s: string): number => Number(/max-height:(\d+)px/.exec(s)?.[1])
    expect(px(retina)).toBeGreaterThan(px(laptop) * 2)
  })

  it('derives the cap from the screen only — never from the window height', () => {
    expect(answerBodyMaxHeight(RETINA)).toBeGreaterThan(answerBodyMaxHeight(LAPTOP))
    // Same display => same cap, no matter how tall the window currently is. (The old rule could not
    // state this at all: its only input WAS the window height.)
    expect(answerBodyMaxHeight(LAPTOP)).toBe(answerBodyMaxHeight(LAPTOP))
  })

  it('stays under the workArea-48 ceiling main clamps to, on every display size', () => {
    for (const avail of [600, LAPTOP, 1400, RETINA]) {
      expect(answerBodyMaxHeight(avail) + 86).toBeLessThanOrEqual(avail - 48)
    }
  })

  it('settles in ONE grow step instead of ratcheting to a display-independent fixed point', () => {
    const CONTENT = 4000 // a long answer — more than any cap here

    // The old rule, kept here as the proof of what regressing would look like: a self-referential cap
    // walks the window up in many native resizes and lands on the SAME height on both displays.
    const vhLaptop = settle((h) => 0.76 * h, { availHeight: LAPTOP, contentHeight: CONTENT })
    const vhRetina = settle((h) => 0.76 * h, { availHeight: RETINA, contentHeight: CONTENT })
    expect(vhRetina.height).toBe(vhLaptop.height)
    expect(vhLaptop.steps).toBeGreaterThan(5)

    const laptop = settle(() => answerBodyMaxHeight(LAPTOP), {
      availHeight: LAPTOP,
      contentHeight: CONTENT
    })
    const retina = settle(() => answerBodyMaxHeight(RETINA), {
      availHeight: RETINA,
      contentHeight: CONTENT
    })

    expect(laptop.steps).toBe(1)
    expect(retina.steps).toBe(1)
    expect(laptop.height).toBeGreaterThan(vhLaptop.height)
    expect(retina.height).toBeGreaterThan(laptop.height * 2)
  })
})
