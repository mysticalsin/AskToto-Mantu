import { describe, expect, it } from 'vitest'
import { FIXTURE_NOW, fixtureDashboard } from '../fixture'
import { fixtureForNotifications } from './notifications.fixture'
import { buildNoticeRows, countsByKind, renderNotifications } from './notifications'

const CTX = { now: FIXTURE_NOW, theme: 'light' as const }

describe('renderNotifications (QA fixture)', () => {
  it('renders the six kind chips, the toolbar, and no inline style=, no em dash', async () => {
    const { data, extra } = await fixtureForNotifications()
    const html = renderNotifications(data, { now: extra.platform![0].ts, theme: 'light' }, extra)
    expect(html).toContain('>Notifications<')
    expect(html).toContain('What needs attention.')
    for (const kind of ['Seat', 'License', 'CRM', 'Connector', 'Skill', 'Platform']) {
      expect(html).toContain(`>${kind}<`)
    }
    expect(html).toContain('data-kind-chip="seat"')
    expect(html).toContain('data-kind-chip="platform"')
    expect(html).toContain('id="notifications-search"')
    expect(html).toContain('data-mark-all-seen')
    expect(html).toContain('data-view-toggle')
    expect(html).not.toContain('style="')
  })

  it('parses the raw seat id back out of data.notices so Approve seat targets the real device', async () => {
    const data = await fixtureDashboard()
    const seatNotice = data.notices.find((n) => n.kind === 'seat-pending')
    expect(seatNotice).toBeTruthy()
    const html = renderNotifications(data, CTX)
    const expectedDeviceId = seatNotice!.id.slice('seat-'.length)
    expect(html).toContain(`data-notice-action="approve-seat" data-device="${expectedDeviceId}"`)
  })

  it('parses the raw CRM id back out of data.notices so Retry targets the real row', async () => {
    const data = await fixtureDashboard()
    const crmNotice = data.notices.find((n) => n.kind === 'crm-failed')
    expect(crmNotice).toBeTruthy()
    const html = renderNotifications(data, CTX)
    const expectedCrmId = crmNotice!.id.slice('crm-'.length)
    expect(html).toContain(`data-notice-action="retry-crm" data-crm="${expectedCrmId}"`)
  })

  it('renders a plain #settings link for a pending skill notice, not a mutation button', async () => {
    const data = await fixtureDashboard()
    expect(data.notices.some((n) => n.kind === 'skill-pending')).toBe(true)
    const html = renderNotifications(data, CTX)
    expect(html).toContain('href="#settings" data-notice-action="open-skill"')
  })

  it('computes a License notice for the license expiring inside 7 days, with a Revoke action and no fabricated "ago" time', async () => {
    const data = await fixtureDashboard()
    const soon = data.licenses.issued.find((r) => !r.revoked && r.exp * 1000 > CTX.now && r.exp * 1000 <= CTX.now + 7 * 24 * 60 * 60 * 1000)
    expect(soon).toBeTruthy()
    const html = renderNotifications(data, CTX)
    expect(html).toContain(`data-notice-action="revoke-license" data-jti="${soon!.jti}"`)
    expect(html).toContain('License expiring soon')
    expect(html).toMatch(/Expires (today|in \d+ days?)/)
  })

  it('renders Connector and Platform rows only once the client supplies them, and re-tests the exact connector id', async () => {
    const { data, extra } = await fixtureForNotifications()
    const now = extra.platform![0].ts
    const withoutExtra = renderNotifications(data, { now, theme: 'light' })
    expect(withoutExtra).not.toContain('data-notice-action="retest-connector"')
    expect(countsByKind(buildNoticeRows(data, now)).connector).toBe(0)

    const withExtra = renderNotifications(data, { now, theme: 'light' }, extra)
    expect(extra.connectors!.length).toBeGreaterThan(0)
    for (const c of extra.connectors!) {
      expect(withExtra).toContain(`data-notice-action="retest-connector" data-connector="${c.id}"`)
    }
    expect(withExtra).toContain('Cloudflare OAuth credentials is not configured')
    expect(countsByKind(buildNoticeRows(data, now, extra)).connector).toBe(extra.connectors!.length)
    expect(countsByKind(buildNoticeRows(data, now, extra)).platform).toBe(extra.platform!.length)
  })

  it('every row carries a searchable data-q and a stable data-notice-id, no two rows collide', async () => {
    const { data, extra } = await fixtureForNotifications()
    const now = extra.platform![0].ts
    const rows = buildNoticeRows(data, now, extra)
    expect(rows.length).toBeGreaterThan(4)
    const ids = rows.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const html = renderNotifications(data, { now, theme: 'light' }, extra)
    expect(html).toContain('data-q="')
  })

  it('shows the named empty state when there is truly nothing to show', () => {
    const empty = {
      notices: [],
      licenses: { empty: true, error: 'No licenses in D1', rows: [], issued: [] }
    } as unknown as Parameters<typeof renderNotifications>[0]
    const html = renderNotifications(empty, CTX)
    expect(html).toContain('Nothing needs attention')
  })

  it('renders a "Country" column header, never "Location" (plan 3.6/3.7b law 5: flags everywhere a country appears)', async () => {
    const data = await fixtureDashboard()
    const html = renderNotifications(data, CTX)
    expect(html).toContain('>Country<')
    expect(html).not.toContain('>Location<')
  })

  it('never fabricates a flag for a notice with no country ISO, but still shows its real city', async () => {
    const data = await fixtureDashboard()
    const seatNotice = data.notices.find((n) => n.kind === 'seat-pending' && n.city)
    expect(seatNotice).toBeTruthy()
    // DashboardPayload['notices'][number] does not carry `country` yet (see the build report's
    // dashboard.ts patch) -- confirms today's fixture shape truly has no ISO to fabricate from.
    expect((seatNotice as unknown as { country?: unknown }).country).toBeUndefined()
    const html = renderNotifications(data, CTX)
    expect(html).toContain('country-flag-none')
    expect(html).toContain(`country-cell-secondary">${seatNotice!.city}<`)
  })

  it('renders the real flag and country name the moment a notice carries an ISO code (dashboard.ts patch land-ready)', async () => {
    const data = await fixtureDashboard()
    const seatIndex = data.notices.findIndex((n) => n.kind === 'seat-pending')
    expect(seatIndex).toBeGreaterThanOrEqual(0)
    const patched = {
      ...data,
      notices: data.notices.map((n, i) => (i === seatIndex ? { ...n, country: 'ca' } : n))
    }
    const html = renderNotifications(patched, CTX)
    expect(html).toContain('src="/assets/flags/ca.svg"')
    expect(html).toContain('country-cell-name">Canada<')
  })
})
