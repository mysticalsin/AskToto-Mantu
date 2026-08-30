import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
const read = (...p: string[]): string =>
  readFileSync(join(__dirname, ...p), 'utf8').replace(/\r\n/g, '\n')

const css = read('styles.css')
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

  it('the overlay root widens its margin while invisible so the halo is not clipped by the window', () => {
    expect(appSrc).toMatch(/contentProtection[^\n]*stealth-glow/)
  })
})
