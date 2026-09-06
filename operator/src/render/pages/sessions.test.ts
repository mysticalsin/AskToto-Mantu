import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForSessions } from './sessions.fixture'
import {
  formatSessionDuration,
  offsetLabel,
  renderSessionDrawerBody,
  renderSessions,
  renderSessionsTableBody,
  type SessionDetailResponse,
  type SeatTimelineResponse
} from './sessions'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderSessions (QA fixture)', () => {
  it('shows a skeleton, not a fake table, when the shared dashboard payload has no session rows', async () => {
    const data = await fixtureDashboard()
    const html = renderSessions(data, CTX)
    expect(html).toContain('>Sessions<')
    expect(html).toContain('data-sessions-skeleton')
    expect(html).toContain('data-loaded="false"')
    expect(html).not.toContain('style="')
  })

  it('renders real session rows from the overlay fixture, newest first, with every motion + a11y hook', async () => {
    const { data, sessions } = await fixtureForSessions()
    expect(sessions.length).toBeGreaterThan(0)
    const html = renderSessions({ ...data, sessions }, CTX)
    expect(html).toContain('data-loaded="true"')
    expect(html).toContain('id="sessions-table"')
    expect(html).toContain('data-session-row="')
    expect(html).toContain('data-device="')
    // dataTable() stripes every row with data-stagger (plan 3.5b: "table rows stagger in 40ms").
    expect(html).toContain('data-stagger')
    // at least one live seat in the fixture pulses via the shared beacon hook.
    if (sessions.some((s) => s.live)) expect(html).toContain('data-beacon')
    // live rows carry a ticking duration hook (plan 3.5b: "duration counters for live sessions
    // tick each second").
    if (sessions.some((s) => s.live)) expect(html).toContain('data-live-duration')
    expect(html).toContain('data-sessions-range')
    expect(html).toContain('data-filters-panel')
    expect(html).toContain('data-view-panel')
    expect(html).toContain('table=sessions')
    expect(html).toContain('id="sessions-toolbar-search"')
    // the rail's global "search seats" field (operator/client/search.ts) indexes seat rows by
    // these exact legacy attributes wherever they appear in the document; this page keeps
    // emitting them so that feature keeps finding seats.
    expect(html).toContain('data-seat-computer=')
    expect(html).toContain('data-seat-identity=')
    expect(html).toContain('id="session-drawer"')
    expect(html).not.toContain('style="')
    expect(html).not.toContain('—')
  })

  it('renders the named empty state (never a fake row) when the overlay has zero sessions', () => {
    const html = renderSessionsTableBody([], CTX.now)
    expect(html).toContain('No sessions yet.')
    expect(html).not.toContain('<table')
  })
})

describe('formatSessionDuration / offsetLabel', () => {
  it('formats without inventing fractional seconds', () => {
    expect(formatSessionDuration(0)).toBe('0:00')
    expect(formatSessionDuration(65_000)).toBe('1:05')
    expect(formatSessionDuration(3_661_000)).toBe('1:01:01')
  })

  it('offsets from a session start, never wall-clock now', () => {
    const start = 1_000_000
    expect(offsetLabel(start, start)).toBe('+0s')
    expect(offsetLabel(start + 65_000, start)).toBe('+1m 5s')
    expect(offsetLabel(start + 3_700_000, start)).toBe('+1h 1m')
  })
})

describe('renderSessionDrawerBody (QA fixture)', () => {
  it('renders the timeline, asks (no text) and connectors from the two real JSON shapes, never prompt text', async () => {
    const { sessions } = await fixtureForSessions()
    const row = sessions[0]
    const detail: SessionDetailResponse = {
      ok: true,
      session: row,
      events: [
        { id: 'e1', ts: row.startedAt + 1000, kind: 'heartbeat', detail: null },
        { id: 'e2', ts: row.startedAt + 5000, kind: 'ask', detail: 'answer' }
      ],
      asks: [
        {
          id: 'a1',
          ts: row.startedAt + 5000,
          mode: 'answer',
          provider: 'anthropic',
          model: 'claude',
          outcome: 'ok',
          rating: null,
          cacheStatus: 'miss',
          questionType: 'factual'
        }
      ]
    }
    const timeline: SeatTimelineResponse = {
      ok: true,
      deviceId: row.deviceId,
      seat: { hostname: row.hostname, email: row.email, os: row.os || 'darwin', appVersion: row.appVersion || '1.0.0', country: row.country, city: row.city },
      approval: 'approved',
      tier: row.tier,
      licenseState: 'approved',
      group: { id: 'grp-1', name: 'Ops team' },
      rows: [
        { id: 'grant-1', ts: row.startedAt + 500, kind: 'grant', integrationId: 'int-1', connectorKind: 'hubspot', connectorLabel: 'HubSpot', connectorStatus: 'connected' }
      ],
      nextCursor: null,
      gatewayCallsAvailable: false
    }
    const html = renderSessionDrawerBody(detail, timeline, CTX.now)
    expect(html).toContain('kind-badge')
    expect(html).toContain('HubSpot')
    expect(html).toContain('Ops team')
    expect(html).toContain('data-session-approve="')
    expect(html).toContain('data-session-revoke="')
    expect(html).toContain('data-copy-device="')
    expect(html).not.toContain('style="')
    // asks are never shown with prompt text, mode/provider chips only.
    expect(html).not.toContain('preview')
    expect(html).not.toContain('prompt_cipher')
  })

  it('still renders identity, timeline and asks while the seat timeline fetch is in flight', async () => {
    const { sessions } = await fixtureForSessions()
    const row = sessions[0]
    const detail: SessionDetailResponse = { ok: true, session: row, events: [], asks: [] }
    const html = renderSessionDrawerBody(detail, null, CTX.now)
    expect(html).toContain(row.deviceId.slice(0, 8))
    expect(html).toContain('No events in this session yet.')
    expect(html).toContain('No asks in this session.')
  })
})
