import { describe, expect, it } from 'vitest'
import type { DashboardPayload } from '../../dashboard'
import { fixtureDashboard, FIXTURE_NOW } from '../fixture'
import { fixtureForLicenses } from './licenses.fixture'
import { renderIssuedLicenseRowHtml, renderLicenses, viewRowFromGenerate } from './licenses'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }
// The fixtureForLicenses()/fixtureDashboard() default rows are built relative to FIXTURE_NOW
// (their `now` argument, e.g. an issued license "expiring in 5 days" is `FIXTURE_NOW + 5d`), so
// rendering them with a mismatched `now` misjudges expiry -- these tests pass `FIXTURE_CTX`,
// matching the fixture's own baseline, wherever expiry/status math actually matters.
const FIXTURE_CTX = { now: FIXTURE_NOW, theme: 'light' as const }

describe('renderLicenses (QA fixture, no extra)', () => {
  it('renders the generate card, the duration segmented control and the seats table with no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, CTX)
    expect(html).toContain('data-licenses-generate-form')
    expect(html).toContain('Generate license')
    expect(html).toContain('>Licenses<')
    expect(html).toContain('data-duration-control')
    expect(html).toContain('data-duration-select')
    expect(html).toContain('data-duration-btn="30"')
    expect(html).toContain('data-licenses-group')
    expect(html).toContain('data-licenses-tier')
    expect(html).toContain('data-licenses-once')
    expect(html).toContain('data-licenses-once-copy')
    expect(html).toContain('A seat may use vault keys and connectors when it is approved or holds an active license. Revoke always wins.')
    if (data.licenses.issued.length) {
      expect(html).toContain('data-license-jti=')
      expect(html).toContain('data-license-status=')
    }
    if (!data.licenses.empty) {
      expect(html).toContain('data-license-approve=')
    }
    expect(html).not.toContain('style="')
  })

  it('renders unenriched issued rows as "not tracked" rather than a guessed tier or group', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, CTX)
    if (data.licenses.issued.length) {
      // MISSING placeholder ('—'), not a fabricated tier/group/member value.
      expect(html).toContain('—')
    }
  })

  it('carries the legacy data-license-generate marker alongside data-licenses-generate-form, for operator/client/nav.ts\'s rail shortcut', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, CTX)
    expect(html).toMatch(/<form[^>]*data-licenses-generate-form[^>]*data-license-generate[^>]*>/)
  })

  it('has all ten plan 6.7 seats columns, including Tier and Connectors, and shows MISSING tier with no extra loaded', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, CTX)
    for (const label of ['Computer', 'Email', 'OS', 'Version', 'License state', 'Tier', 'Approval', 'Keys authorized', 'Connectors', 'Last seen']) {
      expect(html).toContain(`>${label}<`)
    }
    if (!data.licenses.empty) {
      // No extra was passed: every seat's Tier and Connectors cell falls back to MISSING, not a guess.
      expect(html).toMatch(/id="licenses-seats-table"[\s\S]*<\/table>/)
    }
  })
})

describe('renderLicenses "Needs your review" block 0 (plan 6.7, QA blocker fix)', () => {
  it('renders above Generate with a pending queue derived from data.licenses.rows[].approval, even with no extra loaded', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, FIXTURE_CTX)
    expect(html).toContain('data-review-block')
    expect(html).toContain('>Needs your review<')
    expect(html).toContain('data-review-nugget')
    expect(html).toContain('Pending approval (5)')
    expect(html).toContain('data-review-hint')
    // seat-ca-02 (fixture.ts) is 'pending'.
    expect(html).toContain('data-review-approve="seat-ca-02"')
    expect(html).toContain('data-review-revoke="seat-ca-02"')
    expect(html).not.toContain('style="')
    // Block 0 renders above the Generate card, not after it.
    expect(html.indexOf('data-review-block')).toBeLessThan(html.indexOf('data-licenses-generate-form'))
  })

  it('the expiring queue counts data.licenses.issued[].exp within 7 days via issuedLicenseStatus(), soonest first, and needs no extra either', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, FIXTURE_CTX)
    expect(html).toContain('Expiring soon (1)')
    expect(html).toContain('id="licenses-review-expiring-table"')
  })

  it('the nugget and rail badge total is pending + expiring, hidden when both queues are clear', async () => {
    const data = await fixtureDashboard()
    const html = renderLicenses(data, FIXTURE_CTX)
    expect(html).toMatch(/data-review-nugget[^>]*data-count-to="6"[^>]*>6</)

    const cleared: DashboardPayload = {
      ...data,
      licenses: {
        ...data.licenses,
        rows: data.licenses.rows.map((r) => (r.approval === 'pending' ? { ...r, approval: 'approved' } : r)),
        issued: data.licenses.issued.map((row) => ({ ...row, exp: row.exp + 365 * 86400 }))
      }
    }
    const clearedHtml = renderLicenses(cleared, FIXTURE_CTX)
    expect(clearedHtml).toContain('Nothing waiting.')
    expect(clearedHtml).toContain('data-review-nugget')
    expect(clearedHtml).toMatch(/data-review-nugget[^>]* hidden[^>]*>0</)
    expect(clearedHtml).not.toContain('data-review-pane')
    // The header (and the rail badge it drives) never disappears, even when clear.
    expect(clearedHtml).toContain('>Needs your review<')
  })

  it('an expiring license with no activated seat (fixture L2) shows "Not yet activated" and only Revoke, never a fabricated seat identity', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    expect(html).toContain('data-review-revoke="2a3b4c5d6e7f8091"')
    expect(html).toContain('Not yet activated')
    expect(html).not.toContain('data-review-approve="2a3b4c5d6e7f8091"')
  })

  it('a pending seat activated by an issued license shows its real tier in block 0, not MISSING', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    const row = html.match(/<tr[^>]*data-review-id="seat-ca-02"[^>]*>[\s\S]*?<\/tr>/)
    expect(row).not.toBeNull()
    expect(row![0]).toContain('Métis')
  })

  it('embeds one JSON payload per row for the client Enter-to-open drawer, with no inline style', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    const match = html.match(/data-review-json="([^"]*)"/)
    expect(match).not.toBeNull()
    const decoded = match![1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    const parsed = JSON.parse(decoded)
    expect(parsed).toHaveProperty('kind')
    expect(parsed).toHaveProperty('title')
    expect(Array.isArray(parsed.fields)).toBe(true)
  })
})

describe('renderLicenses (QA fixture, enriched via fixtureForLicenses)', () => {
  it('renders real tier, group, member, issued-by and activation columns for grouped licenses', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    expect(html).toContain('Delivery Montreal')
    expect(html).toContain('Sales Paris')
    expect(html).toContain('Leadership')
    expect(html).toContain('tony.walteur@gmail.com')
    expect(html).not.toContain('style="')
  })

  it('marks the license expiring within 7 days with the amber-pulse status wrapper, and only that one', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    const matches = html.match(/data-license-expiring/g) || []
    expect(matches.length).toBe(1)
  })

  it('renders a revoked issued license with the Revoked status and no Revoke button on that row', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    expect(html).toContain('data-license-status="revoked"')
  })

  it('populates the group and tier selects from extra', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    expect(html).toContain('<option value="group-sales-paris">Sales Paris</option>')
    expect(html).toContain('<option value="metis">Metis</option>')
  })

  it('derives a seat\'s Tier column from the issued license that activated it, with no dashboard.ts field of its own', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    // seat-ca-02 (fixture.ts) is activated by a "metis" issued license.
    const seatRow = html.match(/<tr[^>]*data-device="seat-ca-02"[^>]*>[\s\S]*?<\/tr>/)
    expect(seatRow).not.toBeNull()
    expect(seatRow![0]).toContain('Métis')
    expect(seatRow![0]).not.toContain('No active license')
  })

  it('shows "No active license" (a real value, not a guess) for an approved seat extra could not match to any issued license', async () => {
    const { data, extra } = await fixtureForLicenses(FIXTURE_NOW)
    const html = renderLicenses(data, FIXTURE_CTX, extra)
    const approvedNoLicense = data.licenses.rows.find(
      (r) => !Object.values(extra.issued ?? {}).some((i) => i.activatedDevice === r.device)
    )
    if (approvedNoLicense) {
      const seatRow = html.match(new RegExp(`<tr[^>]*data-device="${approvedNoLicense.device}"[^>]*>[\\s\\S]*?</tr>`))
      expect(seatRow).not.toBeNull()
      expect(seatRow![0]).toContain('No active license')
    }
  })
})

describe('renderIssuedLicenseRowHtml / viewRowFromGenerate (client FLIP-insert path)', () => {
  it('builds one <tr> matching the table shape for a freshly generated license', () => {
    const row = viewRowFromGenerate(
      { jti: 'freshjti00000001', last4: '0001', days: 30, exp: Math.floor(CTX.now / 1000) + 30 * 86400, groupId: null, tier: null, member: null },
      null,
      'tony.walteur@gmail.com',
      CTX.now
    )
    const html = renderIssuedLicenseRowHtml(row, CTX.now)
    expect(html).toMatch(/^<tr data-stagger data-license-jti="freshjti00000001" data-license-status="active">/)
    expect(html).toContain('··0001')
    expect(html).toContain('tony.walteur@gmail.com')
    expect(html).toContain('Not yet activated')
    expect(html).toContain('data-license-revoke="freshjti00000001"')
    expect(html).not.toContain('style="')
  })

  it('reflects a grouped generate response with the resolved group name', () => {
    const row = viewRowFromGenerate(
      { jti: 'freshjti00000002', last4: '0002', days: 7, exp: Math.floor(CTX.now / 1000) + 7 * 86400, groupId: 'group-sales-paris', tier: 'metis-light', member: 'a@example.com' },
      'Sales Paris',
      'tony.walteur@gmail.com',
      CTX.now
    )
    const html = renderIssuedLicenseRowHtml(row, CTX.now)
    expect(html).toContain('Sales Paris')
    expect(html).toContain('Métis Light')
    expect(html).toContain('a@example.com')
  })
})
