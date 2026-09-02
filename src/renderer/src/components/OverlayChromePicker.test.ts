import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OVERLAY_LAYOUT_COPY, OVERLAY_LAYOUTS } from '@shared/overlay-chrome'

const picker = readFileSync(join(__dirname, './OverlayChromePicker.tsx'), 'utf8')
const settings = readFileSync(join(__dirname, './Settings.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('Settings overlay chrome cards', () => {
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
  })

  it('switching overlayLayout patches settings immediately', () => {
    expect(settings).toMatch(/<OverlayChromePicker/)
    expect(settings).toMatch(/overlayLayout: id/)
    expect(settings).toMatch(/autoHideOverlay: autoHideOverlayForLayout\(id\)/)
    expect(picker).toMatch(/onClick=\{\(\) => onChange\(id\)\}/)
    expect(picker).toMatch(/overlay-chrome-card--selected/)
  })
})
