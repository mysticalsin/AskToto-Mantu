import { describe, expect, it } from 'vitest'
import { topListCard } from './top-list-card'

describe('topListCard', () => {
  it('uses "1fr 70px" for one value header and "1fr 70px 70px" for two (SPEC rule 5)', () => {
    const one = topListCard({ labelHeader: 'Event', valueHeaders: [{ key: 'count', label: 'Count' }], rows: [] })
    expect(one).toContain('grid-template-columns:1fr 70px')
    expect(one).not.toContain('grid-template-columns:1fr 70px 70px')
    const two = topListCard({
      labelHeader: 'Device',
      valueHeaders: [
        { key: 'views', label: 'Views' },
        { key: 'sess', label: 'Sess.' }
      ],
      rows: []
    })
    expect(two).toContain('grid-template-columns:1fr 70px 70px')
  })

  it('renders tabs, search, rows with a proportional bar, and a footer', () => {
    const html = topListCard({
      tabs: [
        { id: 'devices', label: 'Devices', active: true },
        { id: 'os', label: 'OS' }
      ],
      searchPlaceholder: 'Search devices…',
      searchId: 'devices-search',
      labelHeader: 'Device',
      valueHeaders: [{ key: 'n', label: 'Seats' }],
      rows: [
        { label: 'Tonys-MacBook-Pro', barValue: 10, cells: { n: '10' } },
        { label: 'Other-PC', barValue: 5, cells: { n: '5' } }
      ],
      footerRight: '<span>extra</span>'
    })
    expect(html).toContain('data-tlc-tab="devices"')
    expect(html).toContain('id="devices-search"')
    expect(html).toContain('Tonys-MacBook-Pro')
    expect(html).toContain('width:100%')
    expect(html).toContain('width:50%')
    expect(html).toContain('extra')
  })

  it('renders an empty state, never a fake row', () => {
    const html = topListCard({ labelHeader: 'x', valueHeaders: [{ key: 'n', label: 'N' }], rows: [], emptyTitle: 'No seats yet.' })
    expect(html).toContain('No seats yet.')
  })

  it('escapes labels and never emits an em dash', () => {
    const html = topListCard({
      labelHeader: '<x>',
      valueHeaders: [{ key: 'n', label: 'N' }],
      rows: [{ label: '<y>', cells: { n: '1' } }]
    })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/—/)
  })
})
