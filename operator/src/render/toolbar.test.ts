import { describe, expect, it } from 'vitest'
import { toolbar, toolbarButton, toolbarSearch, viewButton } from './toolbar'

describe('toolbarButton', () => {
  it('renders a labeled pill, toggles the active class, escapes the label', () => {
    const on = toolbarButton({ label: 'Listening', active: true })
    expect(on).toContain('class="tool on"')
    expect(on).toContain('>Listening<')
    const off = toolbarButton({ label: '<x>' })
    expect(off).not.toContain('<x>')
    expect(off).toContain('&lt;x&gt;')
  })
  it('marks disabled buttons for a11y', () => {
    expect(toolbarButton({ label: 'x', disabled: true })).toContain('aria-disabled="true"')
  })
})

describe('toolbarSearch', () => {
  it('renders a search input with an icon and placeholder', () => {
    const html = toolbarSearch({ id: 'events-search', placeholder: 'Search events…' })
    expect(html).toContain('id="events-search"')
    expect(html).toContain('placeholder="Search events…"')
    expect(html).toContain('<svg')
  })
})

describe('viewButton', () => {
  it('renders the View pill', () => {
    expect(viewButton({})).toContain('>View<')
  })
})

describe('toolbar', () => {
  it('lays out left, search, and right (defaulting right to viewButton)', () => {
    const html = toolbar({ left: '<a>left</a>', search: '<b>search</b>' })
    expect(html).toContain('<a>left</a>')
    expect(html).toContain('<b>search</b>')
    expect(html).toContain('>View<')
    expect(html).toContain('sticky-header')
    expect(html).toContain('glass')
  })
  it('never renders an em dash', () => {
    expect(toolbar({ left: 'x' })).not.toMatch(/—/)
  })
  it('never emits an inline style attribute (plan D6)', () => {
    expect(toolbar({ left: 'x' })).not.toContain('style="')
  })
})
