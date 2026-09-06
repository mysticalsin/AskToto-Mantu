import { describe, expect, it } from 'vitest'
import { fixtureDashboard, FIXTURE_NOW } from '../fixture'
import { fixtureForAudit } from './audit.fixture'
import {
  auditRowParts,
  auditTargetLabel,
  classifyAuditGroup,
  computeAuditSummary,
  deriveAuditLinks,
  normalizeAuditJsonRow,
  normalizeChangeTimelineRow,
  renderAudit,
  renderAuditRowsHtml,
  renderAuditTableBody,
  AUDIT_GROUP_LABEL,
  AUDIT_GROUP_ORDER,
  type AuditGroup
} from './audit'

const CTX = { now: FIXTURE_NOW, theme: 'light' as const }

describe('classifyAuditGroup (both naming schemes coexist in this codebase)', () => {
  it('classifies the QA fixture\'s own action names', () => {
    expect(classifyAuditGroup('license-generate')).toBe('licenses')
    expect(classifyAuditGroup('license-revoke')).toBe('licenses')
    expect(classifyAuditGroup('seat-approve')).toBe('seats')
    expect(classifyAuditGroup('seat-revoke')).toBe('seats')
    expect(classifyAuditGroup('integration-rotate')).toBe('connectors')
    expect(classifyAuditGroup('integration-test-failed')).toBe('connectors')
    expect(classifyAuditGroup('skill-approve')).toBe('skills')
  })

  it('classifies the real admin routes\' action names (operator/src/routes/*.ts)', () => {
    expect(classifyAuditGroup('revoke-license')).toBe('licenses')
    expect(classifyAuditGroup('approve-seat')).toBe('seats')
    expect(classifyAuditGroup('revoke-seat')).toBe('seats')
    expect(classifyAuditGroup('vault-write')).toBe('keys')
    expect(classifyAuditGroup('vault-rotate')).toBe('keys')
    expect(classifyAuditGroup('vault-revoke')).toBe('keys')
    expect(classifyAuditGroup('use')).toBe('keys')
    expect(classifyAuditGroup('integration-add')).toBe('connectors')
    expect(classifyAuditGroup('integration-test')).toBe('connectors')
    expect(classifyAuditGroup('integration-test-draft')).toBe('connectors')
    expect(classifyAuditGroup('integration-delivered')).toBe('connectors')
    expect(classifyAuditGroup('reveal')).toBe('reveals')
    expect(classifyAuditGroup('export')).toBe('exports')
    expect(classifyAuditGroup('draft')).toBe('skills')
    expect(classifyAuditGroup('approve')).toBe('skills')
    expect(classifyAuditGroup('reject')).toBe('skills')
    expect(classifyAuditGroup('push')).toBe('skills')
  })

  it('buckets crm-retry, group-*, tier-* and platform.heartbeat under platform, and never returns a blank group', () => {
    expect(classifyAuditGroup('crm-retry')).toBe('platform')
    expect(classifyAuditGroup('group-create')).toBe('platform')
    expect(classifyAuditGroup('group-member-add')).toBe('platform')
    expect(classifyAuditGroup('tier-update')).toBe('platform')
    expect(classifyAuditGroup('tiers-seeded')).toBe('platform')
    expect(classifyAuditGroup('platform.heartbeat')).toBe('platform')
    expect(classifyAuditGroup('')).toBe('platform')
    expect(classifyAuditGroup('something-unknown')).toBe('platform')
  })

  it('every classified group is one of the 8 named groups the toolbar filter offers', () => {
    for (const action of ['license-generate', 'seat-approve', 'vault-write', 'integration-rotate', 'skill-approve', 'reveal', 'export', 'crm-retry']) {
      expect(AUDIT_GROUP_ORDER).toContain(classifyAuditGroup(action))
    }
  })
})

describe('renderAudit (SSR, DashboardPayload.change.timeline only)', () => {
  it('renders the header with the Export action, the summary strip, the toolbar, the table and the drawer, no leaks', async () => {
    const data = await fixtureDashboard()
    const html = renderAudit(data, CTX)

    // header + export action
    expect(html).toContain('>Audit<')
    expect(html).toContain('Every action, every delivery, every reveal, with who and when.')
    expect(html).toContain('data-menu-toggle="export"')
    expect(html).toContain('export.csv?table=audit')
    expect(html).toContain('export.xlsx?table=audit')

    // summary strip (count-up numerals)
    expect(html).toContain('data-audit-summary')
    expect(html).toContain('>Actions<')
    expect(html).toContain('>Reveals<')
    expect(html).toContain('>Deliveries<')
    expect(html).toContain('>Failed connector tests<')
    expect(html).toContain('>Last cron run<')
    expect(html).toMatch(/data-count-to="\d+"/)

    // toolbar: range (incl. custom), filters (all 6), view -- no export here (it lives in the header)
    expect(html).toContain('data-menu-toggle="range"')
    expect(html).toContain('data-range-option="24h"')
    expect(html).toContain('data-range-option="365d"')
    expect(html).toContain('data-range-option="custom"')
    expect(html).toContain('data-custom-range')
    expect(html).toContain('data-menu-toggle="filters"')
    expect(html).toContain('data-filter="actor"')
    expect(html).toContain('data-filter="group"')
    expect(html).toContain('data-filter="route"')
    expect(html).toContain('data-filter="seat"')
    expect(html).toContain('data-filter="connector"')
    expect(html).toContain('data-filter="requestId"')
    expect(html).toContain('id="audit-search"')
    expect(html).toContain('data-view-toggle')
    expect(html).toContain('data-col-toggle="target"')
    expect(html).toContain('data-col-toggle="route"')
    expect(html).toContain('data-col-toggle="requestId"')
    expect(html).toContain('data-col-toggle="detail"')

    // table + drawer
    expect(html).toContain('id="audit-table"')
    expect(html).toContain('data-audit-row')
    expect(html).toContain('id="audit-drawer"')
    expect(html).toContain('data-drawer-links')
    expect(html).toContain('data-audit-load-older')

    // retention line (plan: "Audit rows are kept 365 days. Exports are audited.")
    expect(html).toContain('Audit rows are kept 365 days. Exports are audited.')

    // locks: no inline style, no em dash, no raw secret shape
    expect(html).not.toContain('style="')
    expect(html).not.toMatch(/Bearer |sk-ant-|sk-proj-/)
  })

  it('reads "Not reported" for request id and route on first paint (DashboardPayload.change.timeline carries neither)', async () => {
    const data = await fixtureDashboard()
    expect(data.change.timeline.length).toBeGreaterThan(0)
    const html = renderAudit(data, CTX)
    // every row's request id cell is the shared MISSING glyph, never a fabricated id
    expect(html).not.toContain('data-copy-reqid=')
  })

  it('shows the named empty state when there are truly no audit rows', () => {
    const empty = { change: { timeline: [] } } as unknown as Parameters<typeof renderAudit>[0]
    const html = renderAudit(empty, CTX)
    expect(html).toContain('No audit rows match this filter.')
  })
})

describe('auditActionBadge / row template', () => {
  it('tints the Action badge by group and keeps the raw action string in the title, for every fixture row', async () => {
    const data = await fixtureDashboard()
    const rows = data.change.timeline.map(normalizeChangeTimelineRow)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const { cells } = auditRowParts(row, CTX.now)
      const group = classifyAuditGroup(row.action)
      expect(cells.action).toContain(`kind-audit-${group}`)
      expect(cells.action).toContain(esc(row.action))
    }
  })

  it('every row carries a searchable data-q with no secret-shaped substring', async () => {
    const data = await fixtureDashboard()
    const html = renderAuditTableBody(data.change.timeline.map(normalizeChangeTimelineRow), CTX.now)
    expect(html).toContain('data-q="')
    expect(html).not.toMatch(/sk-ant-|sk-proj-|Bearer /)
  })

  it('renderAuditRowsHtml and renderAuditTableBody render the same cells for the same rows (server/client never drift)', async () => {
    const data = await fixtureDashboard()
    const rows = data.change.timeline.map(normalizeChangeTimelineRow).slice(0, 2)
    const rowsHtml = renderAuditRowsHtml(rows, CTX.now)
    const tableHtml = renderAuditTableBody(rows, CTX.now)
    for (const row of rows) {
      const { cells } = auditRowParts(row, CTX.now)
      expect(rowsHtml).toContain(cells.when)
      expect(tableHtml).toContain(cells.when)
    }
  })
})

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

describe('deriveAuditLinks / auditTargetLabel (best effort, real substrings only)', () => {
  it('extracts a license last4 from the fixture\'s "··XXXX" detail shape', async () => {
    const data = await fixtureDashboard()
    const row = data.change.timeline.map(normalizeChangeTimelineRow).find((r) => classifyAuditGroup(r.action) === 'licenses')
    expect(row).toBeTruthy()
    const links = deriveAuditLinks(row!, 'licenses')
    expect(links.licenseLast4).toMatch(/^[0-9a-z]{4}$/i)
    expect(auditTargetLabel(row!, 'licenses', links)).toBe(`License ··${links.licenseLast4}`)
  })

  it('extracts a seat id from a seats-group row\'s detail', async () => {
    const data = await fixtureDashboard()
    const row = data.change.timeline.map(normalizeChangeTimelineRow).find((r) => classifyAuditGroup(r.action) === 'seats')
    expect(row).toBeTruthy()
    const links = deriveAuditLinks(row!, 'seats')
    expect(links.seatId).toBeTruthy()
    expect(auditTargetLabel(row!, 'seats', links)).toBe(`Seat ${links.seatId}`)
  })

  it('extracts a connector id from route, falling back to the first word of detail', () => {
    const withRoute = { ts: 1, actor: 'tony.walteur@gmail.com', action: 'integration-rotate', detail: 'hubspot credential rotated', askId: null, requestId: null, route: '/v1/admin/integrations/int-hubspot/rotate' }
    expect(deriveAuditLinks(withRoute, 'connectors').connectorHint).toBe('int-hubspot')
    const withoutRoute = { ...withRoute, route: null }
    expect(deriveAuditLinks(withoutRoute, 'connectors').connectorHint).toBe('hubspot')
  })

  it('never derives a link from a secret-shaped detail, and reports "Not reported" honestly', () => {
    const secretLike = {
      ts: 1,
      actor: 'tony.walteur@gmail.com',
      action: 'seat-approve',
      detail: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789',
      askId: null,
      requestId: null,
      route: null
    }
    const links = deriveAuditLinks(secretLike, 'seats')
    expect(links.seatId).toBeNull()
    expect(auditTargetLabel(secretLike, 'seats', links)).toBe('Not reported')
  })
})

describe('fixtureForAudit (all 8 action groups represented, richer audit.json shape)', () => {
  it('covers every one of the 8 action groups, derived from real fixture rows or the real routes', async () => {
    const { rows } = await fixtureForAudit()
    const normalized = rows.map(normalizeAuditJsonRow)
    const seen = new Set<AuditGroup>(normalized.map((r) => classifyAuditGroup(r.action)))
    for (const group of AUDIT_GROUP_ORDER) {
      expect(seen.has(group)).toBe(true)
    }
  })

  it('the reveals row carries the real ask id and the real reveal request/route shape', async () => {
    const { rows } = await fixtureForAudit()
    const reveal = rows.find((r) => classifyAuditGroup(r.action) === 'reveals')
    expect(reveal).toBeTruthy()
    expect(reveal!.ask_id).toBeTruthy()
    expect(reveal!.route).toContain(reveal!.ask_id!)
    expect(reveal!.request_id).toBeTruthy()
  })

  it('the platform row is a genuine pruneRetention() heartbeat, not a hand-typed summary', async () => {
    const { rows } = await fixtureForAudit()
    const heartbeat = rows.find((r) => r.action === 'platform.heartbeat')
    expect(heartbeat).toBeTruthy()
    expect(heartbeat!.actor).toBe('system')
    expect(heartbeat!.detail).toMatch(/staleSessionsClosed \d+/)
  })

  it('the exports row was written by the real export route, not synthesised', async () => {
    const { rows } = await fixtureForAudit()
    const exported = rows.find((r) => classifyAuditGroup(r.action) === 'exports')
    expect(exported).toBeTruthy()
    expect(exported!.detail).toContain('table audit')
    expect(exported!.detail).toContain('format csv')
  })

  it('computeAuditSummary counts reveals, deliveries and the last cron run from the enriched rows', async () => {
    const { rows } = await fixtureForAudit()
    const normalized = rows.map(normalizeAuditJsonRow)
    const summary = computeAuditSummary(normalized)
    expect(summary.reveals).toBeGreaterThanOrEqual(1)
    expect(summary.deliveries).toBeGreaterThanOrEqual(1)
    expect(summary.lastCronRunTs).not.toBeNull()
    expect(summary.actions).toBe(normalized.length)
  })

  it('the hydrated table body renders a real, mono, click-to-copy request id for a row that has one', async () => {
    const { rows } = await fixtureForAudit()
    const normalized = rows.map(normalizeAuditJsonRow).filter((r) => r.requestId)
    expect(normalized.length).toBeGreaterThan(0)
    const html = renderAuditTableBody(normalized, FIXTURE_NOW)
    for (const row of normalized) {
      expect(html).toContain(`data-copy-reqid="${row.requestId}"`)
    }
    expect(html).toContain('au-reqid-check')
  })
})
