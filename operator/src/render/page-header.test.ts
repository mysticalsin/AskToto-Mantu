import { describe, expect, it } from 'vitest'
import { pageHeader } from './page-header'

describe('pageHeader', () => {
  it('renders title, subtitle, and an action', () => {
    const html = pageHeader({ title: 'Events', subtitle: 'Paginate through your events.', action: '<button>Ask</button>' })
    expect(html).toContain('>Events<')
    expect(html).toContain('Paginate through your events.')
    expect(html).toContain('<button>Ask</button>')
  })
  it('renders active and inert tabs distinctly, never a broken link for inert', () => {
    const html = pageHeader({
      title: 'Events',
      tabs: [
        { id: 'events', label: 'Events', active: true },
        { id: 'conversions', label: 'Conversions', inert: true }
      ]
    })
    expect(html).toContain('data-page-tab="events"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('data-inert')
    expect(html).toContain('Not part of this release')
    expect(html).not.toContain('data-page-tab="conversions"')
  })
  it('omits subtitle and tabs blocks when absent', () => {
    const html = pageHeader({ title: 'Settings' })
    expect(html).not.toContain('page-sub')
    expect(html).not.toContain('page-tabs')
  })
  it('escapes title and subtitle, never an em dash', () => {
    const html = pageHeader({ title: '<x>', subtitle: '<y>' })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/—/)
  })
})
