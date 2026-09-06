import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { fixtureForEvents } from './events.fixture'
import {
  findAskTrace,
  formatAskTrace,
  normalizeConsoleEvent,
  normalizeEventListRow,
  renderEventRowsHtml,
  renderEvents,
  renderKindChipButtons,
  type AskTraceLite,
  type EventRowLike
} from './events'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderEvents (QA fixture)', () => {
  it('renders the three tabs, the toolbar, kind chips, the table and the drawer, no leaks', async () => {
    const data = await fixtureDashboard()
    const html = renderEvents(data, CTX)
    expect(data.events.length).toBeGreaterThan(0)

    // pageHeader tabs
    expect(html).toContain('data-page-tab="events"')
    expect(html).toContain('data-page-tab="asks"')
    expect(html).toContain('data-page-tab="crm"')

    // toolbar: listening toggle, range, filters, view, search, export
    expect(html).toContain('data-listen-toggle')
    expect(html).toContain('Listening')
    expect(html).toContain('data-menu-toggle="range"')
    expect(html).toContain('data-menu-toggle="filters"')
    expect(html).toContain('data-view-toggle')
    expect(html).toContain('id="ev-search"')
    expect(html).toContain('table=events')
    expect(html).toContain('export.csv?table=events')
    expect(html).toContain('export.xlsx?table=events')

    // kind chips + table + drawer
    expect(html).toContain('data-kind-chip="all"')
    expect(html).toContain('id="ev-table"')
    expect(html).toContain('data-event-row')
    expect(html).toContain('id="event-drawer"')
    expect(html).toContain('data-drawer-links')
    expect(html).toContain('data-ev-load-older')

    // CRM tab content
    expect(html).toContain('data-crm-status-chip="all"')
    expect(html).toContain('Funnel by connector')
    expect(html).toContain('id="ev-crm-table"')

    // never a token-shaped string, no inline style=""
    expect(html).not.toMatch(/Bearer |sk-ant-/)
    expect(html).not.toContain('style="')
  })

  it('never renders a Retry affordance for a CRM row that is not failed or expired (never auto-sends)', async () => {
    const data = await fixtureDashboard()
    const html = renderEvents(data, CTX)
    const retryable = data.crm.rows.filter((r) => r.status === 'failed' || r.status === 'expired')
    const notRetryable = data.crm.rows.filter((r) => r.status !== 'failed' && r.status !== 'expired')
    expect(retryable.length).toBeGreaterThan(0)
    for (const row of retryable) {
      expect(html).toContain(`data-crm-retry="${row.id}"`)
    }
    for (const row of notRetryable) {
      expect(html).not.toContain(`data-crm-retry="${row.id}"`)
    }
    // Retry is a plain button the client wires with one explicit click handler, never a form
    // that could submit itself or a link that could be pre-fetched.
    expect(html).toMatch(/<button type="button" class="btn" data-crm-retry="[^"]+">Retry<\/button>/)
  })

  it('shows more than one ingest kind once the fixture seeds a heartbeat event (kind chip variety)', async () => {
    const data = await fixtureForEvents()
    const html = renderEvents(data, CTX)
    const kinds = new Set(data.events.map((e) => e.name))
    expect(kinds.has('heartbeat')).toBe(true)
    expect(kinds.has('ask')).toBe(true)
    expect(kinds.has('crm')).toBe(true)
    expect(html).toContain('data-kind-chip="heartbeat"')
    expect(html).toContain('data-kind-chip="ask"')
    expect(html).toContain('data-kind-chip="crm"')
  })
})

describe('normalizeConsoleEvent / normalizeEventListRow', () => {
  it('reads chip values, falls back the Detail column through mode then status, and drops a secret-shaped name', async () => {
    const data = await fixtureDashboard()
    const ask = data.events.find((e) => e.name === 'ask')
    expect(ask).toBeTruthy()
    const row = normalizeConsoleEvent(ask!)
    expect(row.kind).toBe('ask')
    expect(row.detail).not.toBeNull()

    const secretNamed = normalizeConsoleEvent({ id: 'x', ts: 1, name: 'sk-ant-abcdefghijklmnop', hostname: null, email: null, chips: [] })
    expect(secretNamed.kind).toBe('event')
  })

  it('normalizeEventListRow is a pure structural passthrough into EventRowLike', () => {
    const row = normalizeEventListRow({
      id: 'e1',
      ts: 100,
      kind: 'heartbeat',
      hostname: 'Host',
      email: 'a@b.com',
      country: 'CA',
      city: 'Longueuil',
      os: 'darwin',
      appVersion: '1.8.5',
      detail: 'ok',
      deviceId: 'dev-full-id'
    })
    expect(row).toEqual<EventRowLike>({
      id: 'e1',
      ts: 100,
      kind: 'heartbeat',
      hostname: 'Host',
      email: 'a@b.com',
      country: 'CA',
      city: 'Longueuil',
      os: 'darwin',
      appVersion: '1.8.5',
      detail: 'ok',
      deviceId: 'dev-full-id'
    })
  })
})

describe('renderEventRowsHtml', () => {
  it('renders one <tr> per row with the row payload for the drawer, matching the same column order the table uses', () => {
    const rows: EventRowLike[] = [
      {
        id: 'e1',
        ts: CTX.now,
        kind: 'ask',
        hostname: 'Tonys-MacBook-Pro',
        email: 'twalteur@amaris.com',
        country: 'CA',
        city: 'Longueuil',
        os: 'darwin',
        appVersion: '1.8.5',
        detail: 'answer',
        deviceId: 'seat-ca-01'
      }
    ]
    const html = renderEventRowsHtml(rows, CTX.now)
    expect(html).toContain('data-event-id="e1"')
    expect(html).toContain('data-kind="ask"')
    expect(html).toContain('data-row=')
    expect(html).not.toContain('style="')
  })
})

describe('renderKindChipButtons', () => {
  it('renders a chip per kind with a nonzero count, in kindBadge tint order, and marks the active one', () => {
    const html = renderKindChipButtons({ ask: 3, crm: 0, heartbeat: 5 }, 'ask')
    expect(html).toContain('data-kind-chip="all"')
    expect(html).toContain('data-kind-chip="heartbeat"')
    expect(html).toContain('data-kind-chip="ask"')
    expect(html).not.toContain('data-kind-chip="crm"') // zero count: no chip
    expect(html).toMatch(/data-kind-chip="ask" aria-pressed="true"/)
    expect(html).toMatch(/data-kind-chip="all" aria-pressed="false"/)
  })
})

describe('findAskTrace / formatAskTrace', () => {
  const asks: AskTraceLite[] = [
    {
      ts: 1000,
      device_id: 'seat-ca-01-full-device-id',
      mode: 'answer',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      question_type: 'behavioral',
      ttft_ms: 320,
      total_ms: 1800,
      input_tokens: 1200,
      output_tokens: 400,
      cache_read: 900,
      cache_write: 0,
      cache_uncached: 300,
      cache_status: 'hit',
      cache_ttl: '1h',
      outcome: 'answered',
      rating: 'up'
    }
  ]

  it('joins by exact ts and a device id prefix match (covers the SSR 8-char chip and the full hydrated id)', () => {
    expect(findAskTrace({ ts: 1000, deviceId: 'seat-ca-01-full-device-id' }, asks)).toEqual(asks[0])
    expect(findAskTrace({ ts: 1000, deviceId: 'seat-ca-' }, asks)).toEqual(asks[0])
    expect(findAskTrace({ ts: 1000, deviceId: 'no-match' }, asks)).toBeNull()
    expect(findAskTrace({ ts: 999, deviceId: 'seat-ca-01-full-device-id' }, asks)).toBeNull()
    expect(findAskTrace({ ts: 1000, deviceId: null }, asks)).toBeNull()
  })

  it('formats every trace field and computes a real cost estimate, never the prompt text', () => {
    const fields = formatAskTrace(asks[0])
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f.value]))
    expect(byLabel.Mode).toBe('answer')
    expect(byLabel['Question type']).toBe('behavioral')
    expect(byLabel.Provider).toBe('anthropic')
    expect(byLabel.Model).toBe('claude-sonnet-4-6')
    expect(byLabel.Tokens).toBe('1,200 in, 400 out')
    expect(byLabel.Cache).toContain('hit')
    expect(byLabel.Cost).toMatch(/^≈\$0\.\d\d list price$/)
    expect(byLabel.Rating).toBe('up')
    expect(byLabel.Latency).toBe('320 ms to first token, 1,800 ms total')
    expect(fields.map((f) => f.value).join(' ')).not.toMatch(/\?|prompt|question:/i)
  })

  it('reads "Not reported" rather than a lying value when a field was never sent', () => {
    const bare: AskTraceLite = {
      ts: 1,
      device_id: 'd',
      mode: null,
      provider: null,
      model: null,
      question_type: null,
      ttft_ms: null,
      total_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read: null,
      cache_write: null,
      cache_uncached: null,
      cache_status: null,
      cache_ttl: null,
      outcome: null,
      rating: null
    }
    const fields = formatAskTrace(bare)
    for (const f of fields) {
      expect(['Not reported', 'Not rated']).toContain(f.value)
    }
  })
})
