import { describe, expect, it } from 'vitest'
import { connectionDrawer, detailDrawer } from './detail-drawer'

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

  it('has a glass header (plan 3.7 item 5)', () => {
    expect(detailDrawer({ id: 'x' })).toContain('seat-overlay-head glass')
  })

  it('never emits an inline style attribute, footer margin is a class (plan D6)', () => {
    const html = detailDrawer({ id: 'x', footer: '<button>Revoke</button>' })
    expect(html).toContain('drawer-footer')
    expect(html).not.toContain('style="')
  })
})

describe('connectionDrawer', () => {
  it('ships hidden, shows the connector logo and label, and a Docs link when a docsUrl is given', () => {
    const html = connectionDrawer({ kind: 'hubspot', label: 'HubSpot', docsUrl: 'https://developers.hubspot.com' })
    expect(html).toContain('hidden')
    expect(html).toContain('/assets/logos/hubspot.svg')
    expect(html).toContain('HubSpot')
    expect(html).toContain('href="https://developers.hubspot.com"')
    expect(html).toContain('seat-overlay-head glass')
  })

  it('omits the Docs link when there is no docsUrl (custom-rest has none)', () => {
    expect(connectionDrawer({ kind: 'custom-rest', label: 'Custom REST' })).not.toContain('>Docs<')
  })

  it('renders the field grid and footer from row', () => {
    const html = connectionDrawer(
      { kind: 'notion', label: 'Notion' },
      { fields: [{ label: 'Token', value: '****1234' }], footer: '<button>Save</button>' }
    )
    expect(html).toContain('<span class="lbl">Token</span>')
    expect(html).toContain('****1234')
    expect(html).toContain('<button>Save</button>')
    expect(html).toContain('drawer-footer')
    expect(html).not.toContain('style="')
  })
})
