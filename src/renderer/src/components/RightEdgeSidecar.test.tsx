import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const sidecar = readFileSync(join(__dirname, './RightEdgeSidecar.tsx'), 'utf8')
const app = readFileSync(join(__dirname, '../App.tsx'), 'utf8')
const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

describe('right-edge sidecar shell', () => {
  it('keeps an accessible 52px tab while the command drawer is closed', () => {
    expect(sidecar).toMatch(/RIGHT_EDGE_TAB_WIDTH = 52/)
    expect(sidecar).toMatch(/RIGHT_EDGE_DRAWER_WIDTH = 360/)
    expect(sidecar).toMatch(/aria-label="Open Métis"/)
    expect(sidecar).toMatch(/aria-expanded=\{open\}/)
    expect(sidecar).toMatch(/role="complementary"/)
    expect(sidecar).toMatch(/aria-label="Métis command"/)
    expect(sidecar).toMatch(/\{open \? \(/)
    expect(sidecar).toMatch(/onKeyDown/)
    expect(sidecar).toMatch(/event\.key === 'Escape'/)
    expect(sidecar).toMatch(/onClick=\{onClose\}/)
  })

  it('uses only opacity and translateX motion without mounting Bar on right edge', () => {
    expect(css).toMatch(/\.right-edge-sidecar/)
    expect(css).toMatch(/translateX/)
    expect(css).toMatch(/opacity/)
    expect(css).toMatch(/prefers-reduced-motion/)
    expect(css).toMatch(/\.right-edge-sidecar__drawer \{[\s\S]*height: 100%/)
    expect(css).toMatch(/\.right-edge-sidecar__drawer-scroll \{ height: 100%; overflow-y: auto/)
    expect(app).toMatch(/rightEdgePresentation \? \(\s*<RightEdgeSidecar[\s\S]*?\) : <Bar/)
    expect(sidecar).not.toMatch(/window\.toto\.resize/)
  })
})
