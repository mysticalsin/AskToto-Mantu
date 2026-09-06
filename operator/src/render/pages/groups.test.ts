import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForGroups, XSS_GROUP_ID, XSS_GROUP_NAME } from './groups.fixture'
import {
  DEFAULT_TIER_OPTIONS,
  renderGroupDrawerBody,
  renderGroupEditForm,
  renderGroupRowHtml,
  renderGroups,
  renderGroupsTable,
  type GroupDetailPayload,
  type GroupListRow
} from './groups'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderGroups (page shell)', () => {
  it('renders the header, the Add group action and a loading skeleton before any client fetch', async () => {
    const data = await fixtureDashboard(CTX.now)
    const html = renderGroups(data, CTX)
    expect(html).toContain('>Groups<')
    expect(html).toContain('Teams, tiers and the licenses they hold.')
    expect(html).toContain('data-add-group-open')
    expect(html).toContain('data-groups-root')
    expect(html).toContain('id="group-drawer"')
    expect(html).toContain('id="group-add-drawer"')
    expect(html).not.toContain('style="')
  })
})

describe('renderGroupsTable (QA fixture, GET /v1/admin/groups shape)', () => {
  it('renders the reference empty state with no rows', () => {
    const html = renderGroupsTable([], CTX.now)
    expect(html).toContain('No groups yet.')
    expect(html).toContain('A group gives a team a tier and its own licenses.')
    expect(html).not.toContain('style="')
  })

  it('renders every fixture group (real 3 plus the XSS row), escaping a script-tag name as text everywhere it appears', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    expect(fixture.list.length).toBeGreaterThanOrEqual(4)
    const html = renderGroupsTable(fixture.list, fixture.now)

    // Security carry-over: a group literally named "<script>x</script>" must never appear as a
    // live tag in the rendered HTML, only as its escaped text form.
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')

    // The real seeded groups (fixture.ts's buildGroups()) are present with their real derived
    // counts, not hand-typed numbers.
    expect(html).toContain('Sales Paris')
    expect(html).toContain('Delivery Montreal')
    expect(html).toContain('Leadership')
    expect(html).not.toContain('style="')
  })

  it('renders tier badges, license and seat counts, and a single new row in dataTable() shape via renderGroupRowHtml', () => {
    const now = CTX.now
    const row: GroupListRow = {
      id: 'g1',
      name: 'Design team',
      tier: 'metis',
      notes: null,
      createdAt: now - 1000,
      createdBy: 'tony.walteur@gmail.com',
      members: 3,
      licensesIssued: 2,
      licensesActive: 1,
      seatsLive: 1,
      lastActiveAt: now - 500
    }
    const table = renderGroupsTable([row], now)
    expect(table).toContain('Métis')
    expect(table).toContain('1 active')
    expect(table).toContain('2 issued')
    expect(table).toContain('1 live')

    const single = renderGroupRowHtml(row, now)
    expect(single.startsWith('<tr class="group-row" data-stagger')).toBe(true)
    expect(single).toContain('data-group-id="g1"')
    expect(single).not.toContain('style="')
  })

  it('escapes an unknown tier id as a plain chip rather than a fabricated badge', () => {
    const now = CTX.now
    const row: GroupListRow = {
      id: 'g2',
      name: 'Ops',
      tier: '<b>custom</b>',
      notes: null,
      createdAt: now,
      createdBy: null,
      members: 0,
      licensesIssued: 0,
      licensesActive: 0,
      seatsLive: 0,
      lastActiveAt: null
    }
    const table = renderGroupsTable([row], now)
    expect(table).not.toContain('<b>custom</b>')
    expect(table).toContain('&lt;b&gt;custom&lt;/b&gt;')
  })

  // Design gate (Groups, 2026-09-06, finding 3): plan 3.5c reserves the card variant ("rows
  // separated not ruled, rounded first/last-row corners, a --surface band per row, non-uppercase
  // 10px --ink-2 headers") for Connectors, Groups, Licenses and Audit. A regression back to the
  // plain dense/ruled dataTable() default would look wrong on every screenshot but pass every
  // other assertion above, so this locks the wiring in explicitly.
  it('renders the list table with the plan 3.5c card variant, not the default ruled look', () => {
    const row: GroupListRow = {
      id: 'g3',
      name: 'Card variant check',
      tier: 'metis',
      notes: null,
      createdAt: CTX.now,
      createdBy: null,
      members: 1,
      licensesIssued: 0,
      licensesActive: 0,
      seatsLive: 0,
      lastActiveAt: null
    }
    const table = renderGroupsTable([row], CTX.now)
    expect(table).toContain('<table class="dt-card" id="groups-table">')
  })
})

describe('renderGroupDrawerBody (GET /v1/admin/groups/:id shape)', () => {
  it('renders the tab strip, one Members/Licenses/Seats/Connectors/Activity panel each, and escapes the XSS group name, notes and member', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const detail = fixture.detail[XSS_GROUP_ID]
    expect(detail).toBeTruthy()
    expect(detail.group.name).toBe(XSS_GROUP_NAME)

    const html = renderGroupDrawerBody(detail, [], fixture.now, { tiers: DEFAULT_TIER_OPTIONS })

    expect(html).toContain('data-group-tabs')
    for (const id of ['members', 'licenses', 'seats', 'connectors', 'activity']) {
      expect(html).toContain(`data-group-panel="${id}"`)
    }
    // The group's notes and its member's email both carry live HTML in this fixture; neither may
    // survive as a tag.
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<b>bold</b>@example.com')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;@example.com')
    expect(html).not.toContain('style="')
  })

  it('renders real members, licenses, seats and activity for a normal fixture group with no fabricated rows', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const delivery = fixture.list.find((g) => g.name === 'Delivery Montreal')
    expect(delivery).toBeTruthy()
    const detail = fixture.detail[delivery!.id]
    const html = renderGroupDrawerBody(detail, [], fixture.now)
    expect(html).toContain('marc.tremblay@example.com')
    expect(html).not.toContain('style="')
  })

  // Design gate (Groups, 2026-09-06, finding 3): the Licenses and Seats panels are drawer tables
  // too, not just the top-level list -- they get the same plan 3.5c card variant.
  it('renders the Licenses and Seats panels with the card variant', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const delivery = fixture.list.find((g) => g.name === 'Delivery Montreal')!
    const detail = fixture.detail[delivery.id]
    expect(detail.licenses.length).toBeGreaterThan(0)
    expect(detail.seats.length).toBeGreaterThan(0)
    const licensesHtml = renderGroupDrawerBody(detail, [], fixture.now, { activeTab: 'licenses' })
    expect(licensesHtml).toContain('<table class="dt-card" id="group-licenses-table">')
    const seatsHtml = renderGroupDrawerBody(detail, [], fixture.now, { activeTab: 'seats' })
    expect(seatsHtml).toContain('<table class="dt-card" id="group-seats-table">')
  })

  it('renders a Connectors panel from client-supplied, already-scoped connector rows, with the card variant', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const delivery = fixture.list.find((g) => g.name === 'Delivery Montreal')!
    const detail = fixture.detail[delivery.id]
    const html = renderGroupDrawerBody(detail, [{ id: 'int-clickup', kind: 'clickup', label: 'ClickUp workspace', transport: 'rest', mode: 'brokered', health: 'connected' }], fixture.now, {
      activeTab: 'connectors'
    })
    expect(html).toContain('ClickUp workspace')
    expect(html).toContain('Connected')
    expect(html).toContain('<table class="dt-card" id="group-connectors-table">')
  })

  // None of the seeded fixture groups have a real audit-log row (groupActivity() in
  // routes/groups.ts reads listAudit() for rows mentioning the group; the fixture groups are
  // inserted straight into the store, not through an audited route), so this shapes a detail
  // payload directly the way the "tier badges" and "unknown tier" tests above do for
  // GroupListRow -- a render-shape check, not a hand-typed KPI number.
  it('renders the Activity panel with the card variant', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const delivery = fixture.list.find((g) => g.name === 'Delivery Montreal')!
    const base = fixture.detail[delivery.id]
    const detail: GroupDetailPayload = {
      ...base,
      activity: [{ ts: fixture.now - 1000, actor: 'tony.walteur@gmail.com', action: 'edit', detail: 'Renamed group', requestId: null, route: null }]
    }
    const html = renderGroupDrawerBody(detail, [], fixture.now, { activeTab: 'activity' })
    expect(html).toContain('<table class="dt-card" id="group-activity-table">')
  })
})

describe('renderGroupEditForm', () => {
  it('escapes the current name and notes into the form fields', async () => {
    const fixture = await fixtureForGroups(CTX.now)
    const detail = fixture.detail[XSS_GROUP_ID]
    const html = renderGroupEditForm(detail, DEFAULT_TIER_OPTIONS)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('style="')
  })
})
