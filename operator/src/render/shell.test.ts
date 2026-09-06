import { describe, expect, it } from 'vitest'
import { shell } from './shell'
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

  it('shows Generate license on overview/licenses, and a search field elsewhere', () => {
    const overview = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'e', bodyHtml: '' })
    expect(overview).toContain('Generate license')
    const licenses = shell(ctx, { page: 'licenses', title: 'Licenses', live: 0, email: 'e', bodyHtml: '' })
    expect(licenses).toContain('Generate license')
    const events = shell(ctx, { page: 'events', title: 'Events', live: 0, email: 'e', bodyHtml: '' })
    expect(events).not.toContain('Generate license')
    expect(events).toContain('Search seats, events')
    expect(events).toContain('id="nav-search"')
  })

  it('shows a per-nav-item count badge only when > 0', () => {
    const withCount = shell(ctx, { page: 'notifications', title: 'Notifications', live: 0, email: 'e', bodyHtml: '', navCounts: { notifications: 3, licenses: 1 } })
    expect((withCount.match(/class="nav-count"/g) || []).length).toBe(2)
    expect(withCount).toContain('>3<')
    expect(withCount).toContain('>1<')
    const zero = shell(ctx, { page: 'notifications', title: 'Notifications', live: 0, email: 'e', bodyHtml: '', navCounts: { notifications: 0 } })
    expect(zero).not.toContain('nav-count')
  })

  it('renders a three-state theme toggle reflecting ctx.theme', () => {
    const html = shell({ now: 1, theme: 'dark' }, { page: 'settings', title: 'Settings', live: 0, email: 'e', bodyHtml: '' })
    expect(html).toContain('data-theme-choice="system"')
    expect(html).toContain('data-theme-choice="light"')
    expect(html).toContain('data-theme-choice="dark" aria-pressed="true"')
  })

  it('renders the signed-in email, Access chip, and a sign-out form posting to /logout', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 0, email: 'tony.walteur@gmail.com', bodyHtml: '' })
    expect(html).toContain('tony.walteur@gmail.com')
    expect(html).toContain('data-access-solid')
    expect(html).toContain('method="post" action="/logout"')
    expect(html).toContain('Sign out')
  })

  it('embeds bodyHtml verbatim and shows the live count', () => {
    const html = shell(ctx, { page: 'overview', title: 'Overview', live: 7, email: 'e', bodyHtml: '<section data-page="overview">hi</section>' })
    expect(html).toContain('<section data-page="overview">hi</section>')
    expect(html).toContain('LIVE 7')
  })

  it('escapes title/email and never emits an em dash', () => {
    const html = shell(ctx, { page: 'overview', title: '<x>', live: 0, email: '<y>', bodyHtml: '' })
    expect(html).not.toContain('<x>')
    expect(html).not.toContain('<y>')
    expect(html).not.toMatch(/ — /)
  })
})
