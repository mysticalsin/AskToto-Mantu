import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as PanelModule from './Panel'

/**
 * MQA-197 (renderer half) — the panel caps itself against `screen.availHeight`, which changes the moment
 * the overlay lands on another monitor. main re-clamps the WINDOW to the new display's work area; if the
 * panel keeps the old display's cap it stays laid out taller than the window it lives in and clips at the
 * frame with no scrollbar, which is a worse failure than the one the main-side clamp fixes.
 */
function stubWindow(availHeight: number): {
  fireResize: () => void
  setAvailHeight: (h: number) => void
  listenerCount: () => number
} {
  const listeners: Record<string, (() => void)[]> = {}
  const screen = { availHeight }
  vi.stubGlobal('window', {
    screen,
    addEventListener: (evt: string, fn: () => void) => {
      ;(listeners[evt] ??= []).push(fn)
    },
    removeEventListener: (evt: string, fn: () => void) => {
      listeners[evt] = (listeners[evt] ?? []).filter((f) => f !== fn)
    }
  })
  return {
    fireResize: () => (listeners['resize'] ?? []).forEach((fn) => fn()),
    setAvailHeight: (h) => {
      screen.availHeight = h
    },
    listenerCount: () => (listeners['resize'] ?? []).length
  }
}

afterEach(() => vi.unstubAllGlobals())

const RETINA = 2160
const LAPTOP = 1080

describe('MQA-197 — the panel cap follows the overlay between displays', () => {
  it('MQA-197 — re-reads the cap when the overlay lands on a shorter display', () => {
    const dom = stubWindow(RETINA)
    expect(typeof PanelModule.subscribeMaxHeight, 'Panel exposes no display-change subscription').toBe(
      'function'
    )
    const seen: number[] = []
    const unsubscribe = PanelModule.subscribeMaxHeight((h) => seen.push(h))

    // The overlay moves to the 1080p laptop; main clamps the window to that work area, and that resize
    // is the only signal the renderer gets — a display change produces no React state change of its own.
    dom.setAvailHeight(LAPTOP)
    dom.fireResize()

    expect(seen).toEqual([PanelModule.panelMaxHeight(LAPTOP)])
    unsubscribe()
    expect(dom.listenerCount()).toBe(0)
  })

  it('MQA-197 — renders the cap of the display it is currently on', () => {
    stubWindow(LAPTOP)
    const html = renderToStaticMarkup(
      <PanelModule.Panel>
        <div>review</div>
      </PanelModule.Panel>
    )
    expect(html).toContain(`max-height:${PanelModule.panelMaxHeight(LAPTOP)}px`)
  })
})
