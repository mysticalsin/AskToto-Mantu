import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const peek = readFileSync(join(__dirname, './OverlayPeek.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')

describe('OverlayPeek hide rest is invisible', () => {
  it('hide is a transparent hairline; island keeps the visible peek', () => {
    expect(peek).toMatch(/overlay-hide-target/)
    expect(peek).toMatch(/data-hug-width/)
    const hide = css.slice(css.indexOf('.overlay-hide-target {'), css.indexOf('.overlay-peek {'))
    expect(hide).toMatch(/width:\s*8px/)
    expect(hide).toMatch(/height:\s*2px/)
    expect(hide).toMatch(/background:\s*transparent/)
    expect(hide).toMatch(/pointer-events:\s*none/)
    expect(hide).not.toMatch(/rgba\(\s*8,\s*4,\s*16/)
    expect(hide).not.toMatch(/min-height:\s*28px/)
    expect(app).toMatch(/overlayPeeked/)
    expect(app).toMatch(/p-0/)
    expect(app).toMatch(/parkAfterHide/)
    expect(app).toMatch(/overlayShowPeek/)
    expect(app).toMatch(/overlay-spring/)
    expect(app).toMatch(/collapse-now/)
    expect(app).not.toMatch(/overlay-reveal/)
    expect(css).toMatch(/\.overlay-spring--in/)
    expect(css).toMatch(/\.overlay-spring--out/)
    expect(css).toMatch(/transform-origin:\s*top center/)
    expect(css).not.toMatch(/\.overlay-reveal \{/)
  })
})
