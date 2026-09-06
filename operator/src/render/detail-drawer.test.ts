import { describe, expect, it } from 'vitest'
import { detailDrawer } from './detail-drawer'

describe('detailDrawer', () => {
  it('ships hidden by default with a labeled close button and dialog semantics', () => {
    const html = detailDrawer({ id: 'seat-overlay', title: 'Tonys-MacBook-Pro' })
    expect(html).toContain('id="seat-overlay"')
    expect(html).toContain('hidden')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-label="Close"')
    expect(html).toContain('Tonys-MacBook-Pro')
  })

  it('renders a labeled field grid, wide fields get seat-overlay-wide', () => {
    const html = detailDrawer({
      id: 'x',
      fields: [
        { label: 'OS', value: 'darwin' },
        { label: 'Recent', value: 'none', wide: true }
      ]
    })
    expect(html).toContain('<span class="lbl">OS</span>')
    expect(html).toContain('<span class="val">darwin</span>')
    expect(html).toContain('seat-overlay-wide')
  })

  it('escapes id/title and never emits an em dash', () => {
    const html = detailDrawer({ id: 'x', title: '<y>' })
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/ — /)
  })
})
