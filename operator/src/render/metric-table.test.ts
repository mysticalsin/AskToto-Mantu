import { describe, expect, it } from 'vitest'
import { metricTable } from './metric-table'

const columns = [
  { key: 'duration', label: 'Duration', hideBelowPx: 650 as const },
  { key: 'events', label: 'Events', sortable: true, hideBelowPx: 350 as const },
  { key: 'sessions', label: 'Sessions', sortable: true, hideBelowPx: 150 as const }
]

describe('metricTable', () => {
  it('renders a header row and one row per data row with a proportional bar', () => {
    const html = metricTable({
      title: 'Geo',
      labelHeader: 'Country / City',
      columns,
      rows: [
        { label: 'São Paulo', barValue: 58, cells: { duration: '0s', events: '58', sessions: '10' } },
        { label: 'Gangseo-gu', barValue: 37, cells: { duration: '0s', events: '37', sessions: '4' } }
      ]
    })
    expect(html).toContain('Country / City')
    expect(html).toContain('São Paulo')
    expect(html).toContain('data-sort="events"')
    expect(html).toContain('data-sort="sessions"')
    expect(html).toContain('mt-hide-650')
    expect(html).toContain('mt-hide-350')
    expect(html).toContain('mt-hide-150')
    expect(html).toContain('<rect width="100%" height="100%" data-grow/>')
    const secondBarPct = Math.round((37 / 58) * 100)
    expect(html).toContain(`<rect width="${secondBarPct}%" height="100%" data-grow/>`)
    expect(html).not.toContain('style="')
  })

  it('renders headerIcons (top-8 flags), truncated at 8', () => {
    const icons = Array.from({ length: 10 }, (_, i) => `<span>${i}</span>`)
    const html = metricTable({ title: 'Geo', labelHeader: 'x', columns: [], rows: [], headerIcons: icons })
    expect((html.match(/<span>\d<\/span>/g) || []).length).toBe(8)
  })

  it('renders an empty state when rows are empty, never a fake row', () => {
    const html = metricTable({ title: 'Geo', labelHeader: 'x', columns, rows: [], emptyTitle: 'No city geo yet.' })
    expect(html).toContain('No city geo yet.')
  })

  it('escapes labels and never emits an em dash', () => {
    const html = metricTable({
      title: 'Geo',
      labelHeader: 'x',
      columns: [],
      rows: [{ label: '<script>', barValue: 1, cells: {} }]
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/—/)
  })
})
