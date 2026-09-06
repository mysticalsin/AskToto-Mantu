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
    expect(html).toContain('class="table-wrap"')
    expect(html).not.toContain('style="')
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

  it('the default variant renders byte-identical to a plain call with no variant (plan 3.5c)', () => {
    const opts = {
      columns: [{ key: 'name', label: 'Name' }],
      rows: [{ cells: { name: 'x' }, selected: true }],
      emptyTitle: 'empty'
    }
    expect(dataTable(opts)).toBe(dataTable({ ...opts, variant: 'default' as const }))
  })
})

describe('dataTable variant: card (plan 3.5c)', () => {
  it('renders a dt-card table with numeric columns right-aligned mono', () => {
    const html = dataTable({
      variant: 'card',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'count', label: 'Count', numeric: true }
      ],
      rows: [{ cells: { name: 'HubSpot', count: '42' } }],
      emptyTitle: 'empty'
    })
    expect(html).toContain('<table class="dt-card"')
    expect(html).toContain('<td class="dt-card-numeric">42</td>')
    expect(html).toContain('<td class="">HubSpot</td>')
  })

  it('sortable headers render the up/down/neutral arrow and a data-sort hook', () => {
    const neutral = dataTable({
      variant: 'card',
      columns: [{ key: 'name', label: 'Name', sortable: true }],
      rows: [{ cells: { name: 'x' } }],
      emptyTitle: 'empty'
    })
    expect(neutral).toContain('data-sort="name"')
    expect(neutral).toContain('dt-sort-ic')
    const asc = dataTable({
      variant: 'card',
      columns: [{ key: 'name', label: 'Name', sortable: true, sortDirection: 'asc' }],
      rows: [{ cells: { name: 'x' } }],
      emptyTitle: 'empty'
    })
    const desc = dataTable({
      variant: 'card',
      columns: [{ key: 'name', label: 'Name', sortable: true, sortDirection: 'desc' }],
      rows: [{ cells: { name: 'x' } }],
      emptyTitle: 'empty'
    })
    expect(asc).not.toBe(neutral)
    expect(desc).not.toBe(asc)
  })

  it('renders a footer row spanning every column when given', () => {
    const html = dataTable({
      variant: 'card',
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ cells: { a: '1' } }],
      footer: '<span>Total: 1</span>',
      emptyTitle: 'empty'
    })
    expect(html).toContain('<tfoot>')
    expect(html).toContain('colspan="1"')
    expect(html).toContain('Total: 1')
  })

  it('rows stagger and keep the selected class, same as the default variant', () => {
    const html = dataTable({
      variant: 'card',
      columns: [{ key: 'a', label: 'A' }],
      rows: [{ cells: { a: '1' }, selected: true }],
      emptyTitle: 'empty'
    })
    expect(html).toContain('data-stagger')
    expect(html).toContain('is-selected')
  })

  it('still shows the emptyState when rows is empty, same as the default variant', () => {
    const html = dataTable({ variant: 'card', columns: [{ key: 'a', label: 'A' }], rows: [], emptyTitle: 'No rows here.' })
    expect(html).toContain('No rows here.')
    expect(html).not.toContain('<table')
  })
})
