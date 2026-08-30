import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const peek = readFileSync(join(__dirname, './OverlayPeek.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')

describe('OverlayPeek hide pad is hittable', () => {
  it('hide does not hug-width; pointer-enter is on the pad; size matches the wide target', () => {
    expect(peek).toMatch(/onPointerEnter=\{onReveal\}/)
    expect(peek).toMatch(/data-hug-width=\{hidden \? undefined : true\}/)
    expect(peek).toMatch(/overlay-hide-target/)
    const hide = css.slice(css.indexOf('.overlay-hide-target {'), css.indexOf('.overlay-peek {'))
    expect(hide).toMatch(/width:\s*100%/)
    expect(hide).toMatch(/min-width:\s*220px/)
    expect(hide).toMatch(/height:\s*100%/)
    expect(hide).toMatch(/min-height:\s*28px/)
    expect(hide).toMatch(/pointer-events:\s*auto/)
    expect(hide).not.toMatch(/opacity:\s*0\.01/)
    expect(hide).not.toMatch(/background:\s*transparent/)
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
