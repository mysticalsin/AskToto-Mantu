import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_CHROME_PX,
  PANEL_MIN_PX,
  RESIZE_QUANTIZE_PX,
  WINDOW_BOTTOM_RESERVE_PX,
  Panel,
  panelMaxHeight
} from './Panel'

/**
 * MQA-285 — the post-meeting Summary (Review inside Panel) clipped at the window bottom with no
 * scrollbar. html/body/#root are `overflow: hidden`. The Panel is the only scroller. Its old cap
 * (`availHeight - 160`) did not leave enough room for the live Bar (64 orb toolbar + input), stealth
 * `p-5`, `gap-2`, useAutoResize's 24px grow grid, and main's `workArea.height - 48` clamp. Recap
 * content in the dead band — taller than the clamped window, shorter than the cap — never overflowed
 * the Panel, so the last paragraph / actions / footer sat under the frame and the trackpad did nothing.
 *
 * Same class of bug as MQA-198 (in-bar answer), sibling surface, different reserve.
 */

const read = (...p: string[]): string =>
  readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')

function stubAvail(availHeight: number): void {
  vi.stubGlobal('window', { screen: { availHeight } })
}

afterEach(() => vi.unstubAllGlobals())

const LAPTOP = 728 // 1366x768 work area (Bar.answer-height.test.tsx)
const RETINA = 2100
const DISPLAYS = [600, LAPTOP, 1080, 1400, RETINA]

/** The band the old `avail - 160` left: content that fit the panel cap but not the clamped window. */
function oldDeadBand(avail: number): { remaining: number; oldCap: number } {
  const remaining = avail - WINDOW_BOTTOM_RESERVE_PX - PANEL_CHROME_PX
  return { remaining, oldCap: avail - 160 }
}

describe('MQA-285 — summary / recap Panel fits or scrolls, never clips', () => {
  it('MQA-285 — stays under the workArea-48 ceiling main clamps to, on every display size', () => {
    for (const avail of DISPLAYS) {
      const cap = panelMaxHeight(avail)
      expect(cap + PANEL_CHROME_PX + RESIZE_QUANTIZE_PX).toBeLessThanOrEqual(
        avail - WINDOW_BOTTOM_RESERVE_PX
      )
    }
  })

  it('MQA-285 — the old avail-160 reserve leaves a dead band the new cap closes', () => {
    const { remaining, oldCap } = oldDeadBand(LAPTOP)
    expect(oldCap).toBeGreaterThan(remaining)
    expect(panelMaxHeight(LAPTOP)).toBeLessThanOrEqual(remaining)
    // A recap in that band used to clip with no scrollbar. The new cap sits at or below remaining,
    // so content that tall overflows the Panel and overflow-y-auto can reach the last line.
    expect(oldCap - remaining).toBeGreaterThan(0)
  })

  it('MQA-285 — last content is reachable: the shell is a real overflow-y scroller at the screen cap', () => {
    stubAvail(LAPTOP)
    const cap = panelMaxHeight(LAPTOP)
    const html = renderToStaticMarkup(
      <Panel>
        <section>
          <p>first paragraph of the recap</p>
          <p data-last-line>last paragraph of the recap</p>
          <button type="button">Save</button>
        </section>
      </Panel>
    )
    expect(html).toContain('data-panel-scroll')
    expect(html).toContain('overflow-y-auto')
    expect(html).toContain(`max-height:${cap}px`)
    expect(html).toContain('data-last-line')
    expect(html).toContain('Save')
    expect(html).not.toContain('scroll here')
    // Viewport units would reintroduce MQA-198's self-referential cap inside a content-sized window.
    expect(html).not.toContain('vh')
    expect(html).not.toContain('dvh')
  })

  it('MQA-285 — scales with the display and never uses the window height as input', () => {
    expect(panelMaxHeight(RETINA)).toBeGreaterThan(panelMaxHeight(LAPTOP))
    expect(panelMaxHeight(LAPTOP)).toBe(panelMaxHeight(LAPTOP))
    expect(panelMaxHeight(undefined)).toBe(PANEL_MIN_PX)
  })

  it('MQA-285 — Review and sibling recap bodies share this one Panel scroller (no nested trap)', () => {
    const app = read('..', 'App.tsx')
    const review = read('Review.tsx')
    const panel = read('Panel.tsx')
    // Review is the post-meeting Summary Tony opens. It must render inside <Panel>, not a second
    // overflow:hidden shell of its own.
    expect(app).toMatch(/<Panel>/)
    expect(app).toMatch(/view === 'review'/)
    expect(panel).toMatch(/overflow-y-auto/)
    expect(panel).toMatch(/overscroll-y-contain/)
    expect(panel).toMatch(/data-panel-scroll/)
    // Transcript is intentionally not a nested 300px box — one panel scroll for the whole recap.
    expect(review).toMatch(/No inner scroll/)
    expect(review).toMatch(/<ListTree[\s\S]*Summary/)
  })
})
