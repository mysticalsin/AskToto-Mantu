import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readAppCss } from '../../../scripts/lib/read-app-css.mjs'
import { describe, expect, it } from 'vitest'

/**
 * MQA-272 (docs/qa/BUG-LEDGER.md) — the "invisible" (contentProtection / Private-view) indicator lost its
 * multi-colour GLOW.
 *
 * The overlay is supposed to grow a multi-colour aurora glow around its edge whenever it is hidden from
 * screen capture, so the user can see at a glance they are invisible on a shared screen. A lag-reduction
 * pass ("Kill the lag", cc5ea6c) dropped the animation AND left only a 2px static rainbow HAIRLINE — no
 * outer glow at all — which over a real desktop reads as "the glow doesn't appear". The wiring
 * (Bar applies `aw-hidden-rainbow` when stealth) was intact; the VISUAL was gone.
 *
 * The fix restores a real glow: a crisp rainbow rim PLUS a soft multi-colour box-shadow halo that spills
 * outward, with the overlay root widening its transparent margin while stealth is on so the window does
 * not clip the halo. box-shadow (not a pseudo-element) is load-bearing: `.aw-widget` is `overflow:hidden`,
 * so only the element's OWN shadow escapes the clip. It stays static (opacity-only breathe) so it never
 * reintroduces the per-frame repaint the lag pass removed.
 *
 * Pinned as source text (this repo's established structural-proof pattern) because the regression is a
 * CSS/markup shape, not a pure function.
 */
const read = (...p: string[]): string => readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')

const css = readAppCss()
const barSrc = read('components', 'Bar.tsx')
const appSrc = read('App.tsx')

describe('MQA-272 — the invisible-state overlay shows a multi-colour glow, not a bare hairline', () => {
  it('Bar drives the aw-hidden-rainbow class from the stealth prop (wiring intact)', () => {
    expect(barSrc).toMatch(/props\.stealth\s*\?\s*'aw-hidden-rainbow'/)
  })

  it('.aw-hidden-rainbow paints a soft OUTER glow (box-shadow halo), not just a 2px rim', () => {
    const block = css.slice(css.indexOf('.aw-hidden-rainbow {'), css.indexOf('.aw-hidden-rainbow::before'))
    // A real glow needs a blurred box-shadow with reach — the regression was a rim-only indicator with
    // no box-shadow on the element at all.
    expect(block).toMatch(/box-shadow:/)
    // Multi-colour: at least three distinct coloured shadow layers (violet core + cyan + magenta flanks).
    const colours = block.match(/rgba\([^)]*\)/g) ?? []
    expect(colours.length).toBeGreaterThanOrEqual(4)
    // Reach: at least one shadow with a real blur radius (≥ 16px), i.e. it spills past the edge.
    expect(block).toMatch(/0 0 (1[6-9]|[2-9]\d)px/)
  })

  it('the glow stays compositor-cheap: an opacity breathe, never a per-frame conic-angle spin', () => {
    const before = css.slice(css.indexOf('.aw-hidden-rainbow::before'))
    // The rim no longer animates the conic angle (the paint-storm the lag pass killed).
    expect(before).not.toMatch(/animation:\s*cl-rainbow-spin/)
    // It breathes via opacity only (a composited property).
    expect(css).toMatch(/@keyframes aw-hidden-breathe/)
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
  })

  it('C30: the breathe is held keyframes (no frame between visibly different values), same ease-in-out 0.82–1 curve', () => {
    const start = css.indexOf('@keyframes aw-hidden-breathe')
    const body = css.slice(start, css.indexOf('\n}', start))
    const frames = [...body.matchAll(/([\d.]+)%\s*\{\s*opacity:\s*([\d.]+);/g)].map((m) => ({
      at: Number(m[1]) / 100,
      opacity: Number(m[2])
    }))
    // Held, not interpolated: the compositor only needs a frame when the value changes.
    const rule = css.slice(css.indexOf('.aw-hidden-rainbow::before'))
    expect(rule).toMatch(/animation:\s*aw-hidden-breathe 4\.2s step-end infinite/)
    // ~11 updates a second over the 4.2s period, never 120.
    expect(frames.length).toBeGreaterThanOrEqual(40)
    expect(frames.length / 4.2).toBeLessThanOrEqual(12.5)
    expect(frames[0]).toEqual({ at: 0, opacity: 0.82 })
    expect(frames[frames.length - 1]).toEqual({ at: 1, opacity: 0.82 })
    expect(frames.find((frame) => frame.at === 0.5)?.opacity).toBe(1)
    // Each step is at most 0.013 opacity (about 3 of 255 levels), so the sampling is invisible.
    for (let i = 1; i < frames.length; i += 1)
      expect(Math.abs(frames[i].opacity - frames[i - 1].opacity)).toBeLessThanOrEqual(0.013)
    // The samples follow the original per-half ease-in-out (cubic-bezier(0.42, 0, 0.58, 1)).
    const bezier = (t: number, p1: number, p2: number): number =>
      3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3
    const easeInOut = (x: number): number => {
      let lo = 0
      let hi = 1
      for (let i = 0; i < 50; i += 1) {
        const mid = (lo + hi) / 2
        if (bezier(mid, 0.42, 0.58) < x) lo = mid
        else hi = mid
      }
      return bezier((lo + hi) / 2, 0, 1)
    }
    for (const frame of frames) {
      const x = frame.at <= 0.5 ? frame.at * 2 : (1 - frame.at) * 2
      expect(Math.abs(frame.opacity - (0.82 + 0.18 * easeInOut(x)))).toBeLessThanOrEqual(0.0002)
    }
  })

  it('the overlay root widens its margin while invisible so the halo is not clipped by the window', () => {
    expect(appSrc).toMatch(/\(settings\?\.contentProtection \?\? true\) && !minimized\s*\?\s*'p-5 stealth-glow'/)
  })
})
