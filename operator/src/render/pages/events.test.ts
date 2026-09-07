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
  renderEventsStatsSeries,
  renderEventsStatsTables,
  renderKindChipButtons,
  type AskTraceLite,
  type EventRowLike,
  type EventsStatsPayloadLike
} from './events'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderEvents (QA fixture)', () => {
  it('renders the four tabs, the reference-fidelity toolbar, kind chips, the table and the drawer, no leaks', async () => {
    const data = await fixtureDashboard()
    const html = renderEvents(data, CTX)
    expect(data.events.length).toBeGreaterThan(0)

    // pageHeader tabs (plan: Events, Asks, CRM, Stats)
    expect(html).toContain('data-page-tab="events"')
    expect(html).toContain('data-page-tab="asks"')
    expect(html).toContain('data-page-tab="crm"')
    expect(html).toContain('data-page-tab="stats"')

    // toolbar: exactly Listening toggle, range, Filters, View (Tony 2026-09-06 fidelity clause --
    // no search box, no export links: neither is in the reference toolbar).
    expect(html).toContain('data-listen-toggle')
    expect(html).toContain('Listening')
    expect(html).toContain('data-menu-toggle="range"')
    expect(html).toContain('data-menu-toggle="filters"')
    expect(html).toContain('data-view-toggle')
    expect(html).not.toContain('id="ev-search"')
    expect(html).not.toContain('data-export-link')
    expect(html).not.toContain('export.csv?table=events')

    // kind chips + table + drawer
    expect(html).toContain('data-kind-chip="all"')
    expect(html).toContain('id="ev-table"')
    expect(html).toContain('data-event-row')
    expect(html).toContain('id="event-drawer"')
    expect(html).toContain('data-drawer-links')
    expect(html).toContain('data-ev-load-older')

    // Final column set (plan 6.4 correction): Created at, Name, Profile, Country, Platform,
    // Detail -- no Client/Browser column.
    expect(html).toContain('>Created at<')
    expect(html).toContain('>Name<')
    expect(html).toContain('>Profile<')
    expect(html).toContain('>Country<')
    expect(html).toContain('>Platform<')
    expect(html).toContain('>Detail<')
    expect(html).not.toMatch(/>Client<|>Browser</)

    // CRM tab content
    expect(html).toContain('data-crm-status-chip="all"')
    expect(html).toContain('Funnel by connector')
    expect(html).toContain('id="ev-crm-table"')

    // Stats tab shell (client-fetched -- see events.ts's own doc comment)
    expect(html).toContain('data-ev-pane="stats"')
    expect(html).toContain('data-ev-stats-series')
    expect(html).toContain('data-ev-stats-tables')

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
      deviceId: 'dev-full-id',
      questionType: null
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
      deviceId: 'dev-full-id',
      questionType: null
    })
  })
})

describe('row anatomy (plan 6.4, Tony 2026-09-06 correction)', () => {
  function row(overrides: Partial<EventRowLike> = {}): EventRowLike {
    return {
      id: 'e1',
      ts: CTX.now,
      kind: 'heartbeat',
      hostname: 'Tonys-MacBook-Pro',
      email: 'twalteur@amaris.com',
      country: 'CA',
      city: 'Longueuil',
      os: 'darwin',
      appVersion: '1.8.5',
      detail: null,
      deviceId: 'seat-ca-01-full-device-id',
      questionType: null,
      ...overrides
    }
  }

  it('shows an ask question type after the kind badge in the Name cell, never the question text', () => {
    const html = renderEventRowsHtml([row({ kind: 'ask', questionType: 'behavioral' })], CTX.now)
    expect(html).toContain('ev-name-qtype')
    expect(html).toContain('Behavioral')
    expect(html).not.toMatch(/\?|prompt/i)
  })

  it('never shows a question type for a non-ask row even when one is present', () => {
    const html = renderEventRowsHtml([row({ kind: 'heartbeat', questionType: 'behavioral' })], CTX.now)
    expect(html).not.toContain('ev-name-qtype')
  })

  it('reads "Seat <shortid>" for an unidentified seat, never "Anonymous" and never an invented name', () => {
    const html = renderEventRowsHtml([row({ hostname: null, email: null, deviceId: 'abcd1234ef4f2c' })], CTX.now)
    expect(html).toContain('Seat 4f2c')
    expect(html).not.toContain('Anonymous')
  })

  it('shows the real platform mark, the OS name, and the Métis client version in the Platform cell', () => {
    const html = renderEventRowsHtml([row({ os: 'darwin', appVersion: '1.8.5' })], CTX.now)
    expect(html).toContain('ev-platform-mark')
    expect(html).toContain('macOS')
    expect(html).toContain('Métis 1.8.5')
  })

  it('never fabricates a platform cell for an os Métis never reported', () => {
    const html = renderEventRowsHtml([row({ os: null })], CTX.now)
    expect(html).not.toContain('ev-platform-mark')
  })

  it('truncates the Detail cell with the full value in the title attribute', () => {
    const long = '/products/sneakers/' + Array.from({ length: 20 }, (_, i) => `segment-${i}`).join('/')
    const html = renderEventRowsHtml([row({ detail: long })], CTX.now)
    expect(html).toContain(`title="${long}"`)
    expect(html).toContain('ev-detail-cell')
  })

  it('uses countryCell (flag, country name, city underneath) for the Country cell', () => {
    const html = renderEventRowsHtml([row({ country: 'CA', city: 'Longueuil' })], CTX.now)
    expect(html).toContain('country-cell')
    expect(html).toContain('Canada')
    expect(html).toContain('Longueuil')
  })

  it('renders exactly six columns, never a Client or Browser column', () => {
    const html = renderEventRowsHtml([row()], CTX.now)
    const cellCount = (html.match(/<td>/g) || []).length
    expect(cellCount).toBe(6)
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
        deviceId: 'seat-ca-01',
        questionType: null
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

describe('Stats tab render functions (plan 6.4 Stats tab)', () => {
  const stats: EventsStatsPayloadLike = {
    since: CTX.now - 24 * 60 * 60 * 1000,
    until: CTX.now,
    truncated: false,
    byKind: [
      { key: 'heartbeat', count: 5 },
      { key: 'ask', count: 3 }
    ],
    askKindIncluded: true,
    questionTypes: [{ key: 'Factual', count: 2 }],
    questionTypeCoverage: 0.8,
    providers: [{ key: 'anthropic', count: 3 }],
    models: [{ key: 'anthropic / claude-sonnet-4-6', count: 3 }],
    os: [{ key: 'macOS', count: 4 }],
    clientVersions: [{ key: '1.8.5', count: 4 }],
    series: [
      { start: CTX.now - 60 * 60 * 1000, count: 1 },
      { start: CTX.now, count: 2 }
    ],
    seriesBucketMs: 60 * 60 * 1000
  }

  it('renders every dimension as its own metricTable, each with a source tooltip and, where a real filter exists, a click-through attribute', () => {
    const html = renderEventsStatsTables(stats)
    expect(html).toContain('Event kinds')
    expect(html).toContain('Ask question types')
    expect(html).toContain('Providers')
    expect(html).toContain('Models')
    expect(html).toContain('>OS<')
    expect(html).toContain('Client version')
    expect(html).toContain('source-tooltip-mark')
    expect(html).toContain('data-ev-stats-row="kind"')
    expect(html).toContain('data-ev-stats-key="heartbeat"')
    expect(html).toContain('data-ev-stats-row="os"')
    expect(html).toContain('data-ev-stats-key="darwin"')
    expect(html).toContain('data-ev-stats-row="version"')
    expect(html).toContain('data-ev-stats-key="1.8.5"')
    expect(html).toContain('Métis 1.8.5')
    expect(html).not.toContain('style="')
  })

  it('empties the ask-derived tables honestly (never fabricated) when the kind filter excludes ask', () => {
    const html = renderEventsStatsTables({ ...stats, askKindIncluded: false, questionTypes: [], providers: [], models: [] })
    expect(html).toContain('kind filter excludes ask')
  })

  it('renders a small bucketed series with a per-bar source title, summing to the real counts', () => {
    const html = renderEventsStatsSeries(stats)
    expect(html).toContain('ev-stats-spark')
    expect((html.match(/<rect/g) || []).length).toBe(2)
    expect(html).toContain('2 events')
    expect(html).toContain('1 event<')
    expect(html).not.toContain('style="')
  })
})
