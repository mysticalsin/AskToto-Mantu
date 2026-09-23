import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OVERLAY_LAYOUT_COPY, OVERLAY_LAYOUTS } from '@shared/overlay-chrome'
import { OverlayChromePicker } from './OverlayChromePicker'

const picker = readFileSync(join(__dirname, './OverlayChromePicker.tsx'), 'utf8')
const settings = readFileSync(join(__dirname, './Settings.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('Settings overlay chrome cards', () => {
  it('filters Bar at right edge while preserving accessible radio navigation', () => {
    expect(picker).toMatch(/allowedOverlayLayouts\(placement\)/)
    expect(picker).toMatch(/resolveOverlayPresentation/)
    expect(picker).toMatch(/placement: OverlayPlacement/)
    expect(picker).toMatch(/role="radio"/)
    expect(picker).toMatch(/onKeyDown/)
    expect(picker).toMatch(/ArrowRight/)
    expect(picker).toMatch(/min-h-11/)
    expect(picker).toMatch(/aria-live="polite"/)
    expect(picker).toMatch(/Bar is available only at Top center/)
  })

  it('renders a diagram card for hide, island, and bar', () => {
    expect(OVERLAY_LAYOUTS).toEqual(['hide', 'island', 'bar'])
    expect(picker).toMatch(/data-chrome-diagram=\{id\}/)
    expect(picker).toMatch(/overlay-chrome-diagram--\$\{id\}/)
    for (const id of OVERLAY_LAYOUTS) {
      expect(css).toMatch(`.overlay-chrome-diagram--${id}`)
    }
    expect(picker).toMatch(/copy\[id\]\.title/)
    expect(picker).toMatch(/copy\[id\]\.desc/)
    expect(picker).toMatch(/copy = OVERLAY_LAYOUT_COPY/)
    expect(picker).toMatch(/Hidden until you move to the top|OVERLAY_LAYOUT_COPY/)
    expect(OVERLAY_LAYOUT_COPY.hide.desc).toBe('Hidden until you move to the top.')
    expect(OVERLAY_LAYOUT_COPY.island.desc).toBe('A small island stays visible. Hover opens it.')
    expect(OVERLAY_LAYOUT_COPY.bar.desc).toBe('The bar stays on screen.')
    expect(picker).toMatch(/overlay-chrome-diagram__orb/)
    expect(css).toMatch(/overlay-chrome-diagram__orb/)
  })

  // MQA-341: diagrams must show the right edge rather than a horizontal top-edge strip.
  it('draws the right-edge choices vertically and never offers a horizontal bar', () => {
    const markup = renderToStaticMarkup(createElement(OverlayChromePicker, {
      value: 'hide', placement: 'right-edge', locked: false, onChange: () => {}
    }))
    expect(markup).toContain('data-chrome-placement="right-edge"')
    expect(markup).toContain('overlay-chrome-diagram--right-edge')
    expect(markup).toContain('data-chrome-diagram="hide"')
    expect(markup).toContain('data-chrome-diagram="island"')
    expect(markup).not.toContain('data-chrome-diagram="bar"')
    expect(css).toMatch(/\.overlay-chrome-diagram--right-edge\.overlay-chrome-diagram--hide \.overlay-chrome-diagram__mark/)
    expect(css).toMatch(/\.overlay-chrome-diagram--right-edge\.overlay-chrome-diagram--island \.overlay-chrome-diagram__mark/)
  })

  it('switching overlayLayout patches settings immediately', () => {
    expect(settings).toMatch(/<OverlayChromePicker/)
    expect(settings).toMatch(/overlayLayout: id/)
    expect(settings).toMatch(/autoHideOverlay: autoHideOverlayForLayout\(id\)/)
    expect(picker).toMatch(/onClick=\{\(\) => onChange\(id\)\}/)
    expect(picker).toMatch(/overlay-chrome-card--selected/)
  })
})
