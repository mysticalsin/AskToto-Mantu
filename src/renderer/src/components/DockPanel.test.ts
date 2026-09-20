import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('DockPanel Cap4 DESIGN contract', () => {
  const src = readFileSync(join(__dirname, 'DockPanel.tsx'), 'utf8')
  const css = readFileSync(join(__dirname, '../styles.css'), 'utf8')

  it('has Ask field and icon rows, not stub bordered text-only stack', () => {
    expect(src).toMatch(/Ask anything/)
    expect(src).toMatch(/overlay-dock-panel__ask-input/)
    expect(src).toMatch(/AudioLines/)
    expect(src).toMatch(/Brain/)
    expect(src).toMatch(/MetisMark/)
    expect(src).not.toMatch(/Right edge/)
  })

  it('Settings is footer ghost, not a fourth primary equal button', () => {
    expect(src).toMatch(/overlay-dock-panel__settings/)
    expect(src).toMatch(/overlay-dock-panel__foot/)
  })

  it('styles use glass panel language', () => {
    expect(css).toMatch(/\.overlay-dock-panel\s*\{/)
    expect(css).toMatch(/backdrop-filter:\s*blur\(24px/)
    expect(css).not.toMatch(/Right edge/)
  })
})
