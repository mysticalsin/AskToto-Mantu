import { describe, expect, it } from 'vitest'
import { railActionFor, shell } from './shell'
import { NAV_IDS } from '../nav'

const ctx = { now: 1_725_000_000_000, theme: 'light' as const }

describe('shell', () => {
  it('renders every real nav id once, marks the active page, and includes the mobile toggle + backdrop', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 3, email: 'tony@example.com', bodyHtml: '<section>x</section>' })
    const navIds = [...html.matchAll(/data-nav="([^"]+)"/g)].map((m) => m[1])
    expect(navIds).toEqual([...NAV_IDS])
    expect(html).toContain('data-nav="overview" href="#overview" aria-current="page"')
    expect(html).toContain('id="rail-toggle"')
    expect(html).toContain('id="rail-backdrop"')
    expect(html).toContain('aria-label="Toggle menu"')
  })

  it('includes the new Fleet/Ops nav ids (groups, connectors, audit)', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('data-nav="groups"')
    expect(html).toContain('data-nav="connectors"')
    expect(html).toContain('data-nav="audit"')
    expect(html).toContain('>Groups<')
    expect(html).toContain('>Connectors<')
    expect(html).toContain('>Audit<')
  })

  it('railActionFor maps overview/licenses to generate, connectors to connector, and everything else to search', () => {
    expect(railActionFor('overview')).toBe('generate')
    expect(railActionFor('licenses')).toBe('generate')
    expect(railActionFor('connectors')).toBe('connector')
    for (const id of NAV_IDS.filter((n) => n !== 'overview' && n !== 'licenses' && n !== 'connectors')) {
      expect(railActionFor(id), id).toBe('search')
    }
  })

  it('renders all three primary-action variants always (operator/client/router.ts toggles which is hidden on every route change), the right one visible for opts.page', () => {
    const overview = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(overview).toContain('Generate license')
    expect(overview).toContain('Add connector')
    expect(overview).toContain('Search seats, licenses, groups')
    expect(overview).toContain('data-rail-action="generate" data-rail-generate>')
    expect(overview).toContain('data-rail-action="connector" data-rail-add-connector hidden>')
    expect(overview).toContain('data-rail-action="search" data-rail-search hidden>')

    const connectors = shell(ctx, { page: 'connectors', title: 'Connectors', live: 0, email: 'e', bodyHtml: '' })
    expect(connectors).toContain('data-rail-action="connector" data-rail-add-connector>')
    expect(connectors).toContain('data-rail-action="generate" data-rail-generate hidden>')
    expect(connectors).toContain('data-rail-action="search" data-rail-search hidden>')

    const events = shell(ctx, { page: 'events', title: 'Events', live: 0, email: 'e', bodyHtml: '' })
    expect(events).toContain('id="nav-search"')
    expect(events).toContain('data-rail-action="search" data-rail-search>')
    expect(events).toContain('data-rail-action="generate" data-rail-generate hidden>')
    expect(events).toContain('data-rail-action="connector" data-rail-add-connector hidden>')
  })

  it('ships an empty search results dropdown next to the search field, no command palette', () => {
    const html = shell(ctx, { page: 'events', title: 'Events', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('data-rail-search')
    expect(html).toContain('data-search-results')
    expect(html).toMatch(/data-search-results hidden/)
    expect(html).not.toContain('data-palette')
    expect(html).not.toContain('data-shortcuts-sheet')
    expect(html).not.toContain('command palette')
  })

  it('shows a per-nav-item count badge only when > 0, tagged with data-badge for licenses/notifications/connectors', () => {
    const withCount = shell(ctx, { page: 'notifications', title: 'Notifications', live: 0, email: 'e', bodyHtml: '', navCounts: { notifications: 3, licenses: 1 } })
    expect((withCount.match(/class="nav-count"/g) || []).length).toBe(2)
    expect(withCount).toContain('>3<')
    expect(withCount).toContain('>1<')
    expect(withCount).toContain('data-badge="notifications"')
    expect(withCount).toContain('data-badge="licenses"')
    const zero = shell(ctx, { page: 'notifications', title: 'Notifications', live: 0, email: 'e', bodyHtml: '', navCounts: { notifications: 0 } })
    expect(zero).not.toContain('nav-count')
  })

  it('renders a three-state theme toggle reflecting ctx.theme', () => {
    const html = shell({ now: 1, theme: 'dark' }, { page: 'settings', title: 'Settings', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('data-theme-choice="system"')
    expect(html).toContain('data-theme-choice="light"')
    expect(html).toContain('data-theme-choice="dark" aria-pressed="true"')
  })

  it('renders the signed-in email, a Private/Access chip, and a sign-out form posting to /logout', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'tony.walteur@gmail.com', bodyHtml: '' })
    expect(html).toContain('tony.walteur@gmail.com')
    expect(html).toContain('data-access-solid')
    expect(html).toContain('Private, Access')
    expect(html).toContain('method="post" action="/logout"')
    expect(html).toContain('Sign out')
  })

  it('renders an inert project pill with no switcher affordance', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('Métis Operator')
    expect(html).toContain('data-rail-pill')
    expect(html).not.toContain('data-rail-switcher')
  })

  it('embeds bodyHtml verbatim and reflects the live count in the rail live indicator', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 7, email: 'e', bodyHtml: '<section data-page="overview">hi</section>' })
    expect(html).toContain('<section data-page="overview">hi</section>')
    expect(html).toContain('data-live-indicator')
    expect(html).toContain('data-state="live"')
    expect(html).toContain('Live, 7 online')
  })

  it('renders the mobile top bar (menu button, page title, live dot)', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('class="mobile-bar"')
    expect(html).toContain('id="page-title"')
    expect(html).toContain('data-live-dot')
  })

  it('renders the toast region with aria-live polite', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('data-toasts')
    expect(html).toContain('aria-live="polite"')
  })

  it('escapes title/email and never emits an em dash', () => {
    const html = shell(ctx, { page: 'overview', title: '<x>', live: 0, email: '<y>', bodyHtml: '' })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/ — /)
  })
})
