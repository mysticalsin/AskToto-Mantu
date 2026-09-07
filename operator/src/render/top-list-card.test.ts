import { describe, expect, it } from 'vitest'
import { topListCard } from './top-list-card'

describe('topListCard', () => {
  it('uses the cols-1 class for one value header and cols-2 for two (SPEC rule 5), never an inline style', () => {
    const one = topListCard({ labelHeader: 'Event', valueHeaders: [{ key: 'count', label: 'Count' }], rows: [] })
    expect(one).toContain('tlc-row tlc-head cols-1')
    expect(one).not.toContain('cols-2')
    expect(one).not.toContain('style="')
    const two = topListCard({
      labelHeader: 'Device',
      valueHeaders: [
        { key: 'views', label: 'Views' },
        { key: 'sess', label: 'Sess.' }
      ],
      rows: []
    })
    expect(two).toContain('tlc-row tlc-head cols-2')
    expect(two).not.toContain('style="')
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
    expect(html).toContain('<rect width="100%" height="100%" data-grow/>')
    expect(html).toContain('<rect width="50%" height="100%" data-grow/>')
    expect(html).toContain('extra')
    expect(html).not.toContain('style="')
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
