import { describe, expect, it } from 'vitest'
import { dataTable } from './data-table'

describe('dataTable', () => {
  it('renders a header and one row per data row', () => {
    const html = dataTable({
      columns: [
        { key: 'ts', label: 'Created at' },
        { key: 'name', label: 'Name' }
      ],
      rows: [{ cells: { ts: 'now', name: 'heartbeat' } }],
      emptyTitle: 'No events found'
    })
    expect(html).toContain('<th>Created at</th>')
    expect(html).toContain('<th>Name</th>')
    expect(html).toContain('<td>heartbeat</td>')
    expect(html).toContain('overflow-x:auto')
  })

  it('renders an emptyState (title + description) instead of a table when rows is empty', () => {
    const html = dataTable({
      columns: [{ key: 'ts', label: 'Created at' }],
      rows: [],
      emptyTitle: 'No events found',
      emptyDescription: 'Nothing matches the current filters.'
    })
    expect(html).toContain('No events found')
    expect(html).toContain('Nothing matches the current filters.')
    expect(html).not.toContain('<table')
  })

  it('passes through row attrs for click/data-q hooks', () => {
    const html = dataTable({
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ cells: { name: 'x' }, attrs: 'data-event="abc" data-q="x"' }],
      emptyTitle: 'empty'
    })
    expect(html).toContain('data-event="abc"')
    expect(html).toContain('data-q="x"')
  })

  it('escapes header labels and never emits an em dash', () => {
    const html = dataTable({ columns: [{ key: 'a', label: '<x>' }], rows: [{ cells: { a: '1' } }], emptyTitle: 'e' })
    expect(html).not.toContain('<x>')
    expect(html).not.toMatch(/ — /)
  })
})
