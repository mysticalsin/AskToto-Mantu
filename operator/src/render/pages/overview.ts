/**
 * Overview page (plan 6.2, P1.2). Answers plan 3.7b law 2's six questions top left to bottom
 * right: who is live (toolbar live chip, Live seats tile), how much time Métis saved (Time
 * saved tile), what that time is worth (Value tile, law 3), what it cost in tokens (Tokens
 * card), where the seats are (Countries card, Map card), what needs attention (delta chips,
 * empty states -- Notifications owns the actionable list, plan 6.8).
 *
 * Rebuilt from scratch on the plan 6.2 render primitives (P0.4 replaced the old ui.ts-derived
 * scaffold this file used to be with an empty pass-through; this is the real page). Every number
 * traces to a real `DashboardPayload` field -- see the "Data gaps" note in the task report for
 * the handful of fields this page could not source honestly from the current payload shape
 * (tier per seat/license, a previous-period comparison series, a per-minute live series,
 * output-token totals) and how each is handled without inventing data (plan lock 3).
 */
import type { DashboardPayload } from '../../dashboard'
import { choroplethMini } from '../../charts'
import { looksLikeSecret } from '../../redact'
import { geoCountryRollup } from '../../realtime-geo'
import { connectorRow, type ConnectorRow, type ConnectorTransport } from '../connectors-list'
import {
  avatar,
  chip,
  COUNTRY_NAMES,
  deltaChip,
  emptyState,
  esc,
  flag,
  formatCompact,
  iconSvg,
  KIND_ICON_PATHS,
  kindBadge,
  NAV_ICON_PATHS,
  relativeTime,
  pageHeader,
  segmented,
  skeletonRows,
  sourceTooltip,
  statusDot,
  timeCell,
  toolbar,
  toolbarButton,
  toolbarSearch,
  topListCard,
  type RenderCtx,
  type TopListRow,
  type TopListValueHeader
} from '../index'
import { field } from './_shared'
import { areaChartWithPrevious, miniBars, recolorChoroplethMini, tokenStackBar, type TokenParts } from './overview-charts'

const DAY_MS = 24 * 60 * 60 * 1000

// QA (page-height budget, plan 3.7b #10: "no page needs more than two viewport heights ... long
// collections are paged, filtered or capped"): every tabbed list pane below already capped its
// rows at a flat `10` -- at 25px/row that alone pushed the Seats card (the fleet's largest real
// list) to 409px and the rendered page past the two-viewport-height budget. Pulling that one
// constant down is the single highest-leverage, lowest-risk trim available on this page: every
// pane that already fit under 6 rows (Countries' own 6, Asks' Modes, Licenses' States, Events)
// renders byte-identical rows either way, so nothing currently visible is hidden -- only the
// panes that were already overflowing (Seats, Asks' Question types, Countries' Regions/Cities)
// draw fewer rows.
const TLC_ROW_CAP = 6

/**
 * How long the fleet may stay quiet before the Overview says so.
 *
 * Métis heartbeats every 60 seconds, so two missed beats is already unusual and five minutes is
 * unambiguous. Kept well above the beat interval so a seat that is merely between beats, or a
 * laptop that slept for a moment, never trips it.
 */
const FLEET_SILENT_AFTER_MS = 5 * 60 * 1000

/**
 * Says out loud when nothing is arriving.
 *
 * Every number on this page is derived from seat heartbeats, so a fleet that cannot reach the
 * Worker renders exactly like a fleet that is simply idle: zeros everywhere, no errors, nothing to
 * click. That is the state Tony hit -- Métis running on several Macs, the console reporting zero
 * live seats, and no way to tell from this page whether the seats were quiet or unheard. They were
 * unheard: a seat only starts its heartbeat once it has BOTH an Operator URL and an ingest secret,
 * and until then it never contacts the Worker at all, silently.
 *
 * So when the newest heartbeat is old (or there has never been one), the page leads with that fact
 * and the reason, instead of leaving a wall of zeros to be misread as real. When the fleet is
 * healthy this renders nothing: a banner that is always present is a banner nobody reads.
 */
export function renderFleetContactBanner(data: DashboardPayload): string {
  const now = data.now
  const lastSeen = data.profiles.reduce((newest, p) => (p.lastSeen > newest ? p.lastSeen : newest), 0)
  if (lastSeen && now - lastSeen < FLEET_SILENT_AFTER_MS) return ''
  const headline = lastSeen
    ? `No seat has reported in ${esc(relativeTime(lastSeen, now))}.`
    : 'No seat has ever reported to this Operator.'
  const since = lastSeen ? ` Last contact ${timeCell(lastSeen, now)}.` : ''
  return `<article class="card ov-quiet-card" data-ov-quiet>
    <div class="ov-quiet-head">${iconSvg(KIND_ICON_PATHS.heartbeat, { class: 'ov-quiet-icon' })}<h3>${headline}</h3></div>
    <p class="ov-quiet-body">Every figure below is counted from seat heartbeats, so they read zero because nothing is arriving, not because the fleet is idle.${since}</p>
    <p class="ov-quiet-body">Métis heartbeats every 60 seconds, but only once a seat has both an Operator URL and an ingest secret. Set them on each Mac in Métis under Settings, then Operator.</p>
  </article>`
}

export function renderOverview(data: DashboardPayload, _ctx: RenderCtx): string {
  return `${pageHeader({
    title: 'Overview',
    subtitle: 'Who is live, what Métis is saving, and where the fleet is right now.'
  })}
  ${renderFleetContactBanner(data)}
  ${renderToolbar(data)}
  ${renderMetricTilesBlock(data)}
  ${renderTokensCard(data)}
  ${renderAreaChartCard(data)}
  <div class="ov-grid" data-overview-grid>
    ${renderSeatsCard(data)}
    ${renderAsksCard(data)}
    ${renderEventsCard(data)}
    ${renderLicensesCard(data)}
    ${renderCountriesCard(data)}
    ${renderConnectorsCard(data)}
    ${renderMapCard(data)}
  </div>
  ${renderGenerateLicenseCard()}`
}

// ---------------------------------------------------------------------------
// Money.
// ---------------------------------------------------------------------------

function formatMoney(minor: number, currency: string): string {
  const amount = minor / 100
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString('en-US')}`
  }
}

// ---------------------------------------------------------------------------
// Toolbar (range, granularity, Filters, search, live count chip, Private pill).
// ---------------------------------------------------------------------------

/**
 * Range and granularity are real controls (they write `?range=` to the URL, plan brief: "Range
 * handled by ?range on the dashboard route if it exists, otherwise 7 d and say so"), but
 * `operator/src/routes/admin-core.ts`'s dashboard route calls `buildDashboard()` with no range
 * option today (confirmed against the current source; not owned by this page, see the report's
 * data-gap note), so every aggregate on this page is always the fixed window `buildDashboard()`
 * itself computes (mostly the last 7 days). `operator/client/pages/overview.ts` says so with a
 * toast the moment a seat picks 24 h or 30 d, rather than silently pretending the data changed.
 */
function renderToolbar(data: DashboardPayload): string {
  const rangeSeg = segmented({
    items: [
      { id: '24h', label: '24 h' },
      { id: '7d', label: '7 d', active: true },
      { id: '30d', label: '30 d' }
    ],
    attrs: 'data-ov-range'
  })
  const granularitySeg = segmented({
    items: [
      { id: 'hour', label: 'Hour' },
      { id: 'day', label: 'Day', active: true }
    ],
    attrs: 'data-ov-granularity'
  })
  const filtersBtn = toolbarButton({
    label: 'Filters',
    attrs: 'data-ov-filters-toggle aria-haspopup="true" aria-expanded="false"'
  })
  const left = `<div class="ov-toolbar-controls">${rangeSeg}${granularitySeg}<div class="ov-filters-wrap">${filtersBtn}${renderFiltersMenu(data)}</div></div>`
  const search = toolbarSearch({
    id: 'ov-search',
    placeholder: 'Search seats, asks, events, countries',
    attrs: 'data-ov-search'
  })
  const liveChip = `<span class="chip chip-ok ov-live-chip"><i class="ov-beacon-dot" data-beacon aria-hidden="true"></i><span data-world-live>LIVE ${data.roi.liveSeats}</span></span>`
  const privatePill = chip({ label: 'Private' })
  return toolbar({ left, search, right: `${liveChip}${privatePill}` })
}

function renderFiltersMenu(data: DashboardPayload): string {
  const os = data.scale.os.slice(0, 8).map((o) => ({ label: `${o.label} (${o.value})`, value: o.label }))
  const versions = data.scale.versions.slice(0, 8).map((o) => ({ label: `${o.label} (${o.value})`, value: o.label }))
  const countries = geoCountryRollup(data.geo)
    .slice(0, TLC_ROW_CAP)
    .map((c) => ({ label: `${COUNTRY_NAMES[c.country.toUpperCase()] || c.country} (${c.count})`, value: c.country }))
  const group = (title: string, facet: string, options: { label: string; value: string }[]): string => {
    if (!options.length) return ''
    return `<fieldset class="ov-filter-group">
      <legend>${esc(title)}</legend>
      ${options
        .map(
          (o) =>
            `<label class="ov-filter-option"><input type="checkbox" data-ov-filter-input data-ov-filter-facet="${esc(facet)}" value="${esc(o.value)}"> ${esc(o.label)}</label>`
        )
        .join('')}
    </fieldset>`
  }
  return `<div class="ov-filter-menu" hidden data-ov-filter-menu role="menu">
    <p class="sub muted">Filters the lists below. The tiles above stay fleet-wide.</p>
    ${group('OS', 'os', os)}
    ${group('Country', 'country', countries)}
    ${group('Version', 'version', versions)}
    <button type="button" class="btn ov-filter-clear" data-ov-filter-clear>Clear filters</button>
  </div>`
}

// ---------------------------------------------------------------------------
// Metric tiles.
// ---------------------------------------------------------------------------

function ovTile(opts: {
  label: string
  valueHtml: string
  flashKey: string
  rawValue?: number
  live?: boolean
  delta?: number | null
  captionHtml?: string
  spark?: string
  formula?: string
  source?: string
}): string {
  const badge = opts.live
    ? '<span class="live" aria-hidden="true" data-beacon></span>'
    : deltaChip(opts.delta ?? null, { flashKey: opts.flashKey })
  const countAttr = typeof opts.rawValue === 'number' ? ` data-count-to="${opts.rawValue}"` : ''
  const sourceMark = opts.formula && opts.source ? sourceTooltip(opts.formula, opts.source) : ''
  return `<div class="mtile">
    <div class="kpi-top"><span class="eyebrow eyebrow-flush">${esc(opts.label)}${sourceMark}</span>${badge}</div>
    <div class="n"${countAttr} data-flash-key="${esc(opts.flashKey)}">${opts.valueHtml}</div>
    ${opts.captionHtml ? `<div class="sub">${opts.captionHtml}</div>` : ''}
    ${opts.spark || ''}
  </div>`
}

/**
 * `roi.hourlyRate == null` renders the plan 3.7b law 3 empty state, linking to Settings. The
 * shared `metricTiles()` primitive escapes both `value` and `caption`, so it cannot carry a real
 * `<a>` -- this page builds its own tile cells (mirroring `metricTiles.ts`'s exact markup and
 * classes) instead of forking the primitive for one link.
 */
function renderValueTile(roi: DashboardPayload['roi']): string {
  if (roi.hourlyRate == null || roi.valueMinor == null) {
    return ovTile({
      label: 'Value',
      valueHtml: '<a class="ov-value-link" href="#settings">Set an hourly rate to see value</a>',
      flashKey: 'tile-value',
      captionHtml: esc('time saved multiplied by an hourly rate'),
      formula: 'Time saved multiplied by the hourly rate set in Settings, Value',
      source: 'operator_settings, value'
    })
  }
  return ovTile({
    label: 'Value',
    valueHtml: esc(formatMoney(roi.valueMinor, roi.currency)),
    flashKey: 'tile-value',
    captionHtml: esc(`${roi.currency} · time saved x hourly rate, 7 days`),
    formula: 'Time saved multiplied by the hourly rate set in Settings, Value',
    source: 'operator_settings, value'
  })
}

function renderMetricTilesBlock(data: DashboardPayload): string {
  const ops = data.ops
  const roi = data.roi
  const askPerSeat = ops.uniqueSessions > 0 ? ops.apiCalls / ops.uniqueSessions : null
  const tiles = [
    ovTile({
      label: 'Live seats',
      valueHtml: esc(String(roi.liveSeats)),
      flashKey: 'tile-live',
      rawValue: roi.liveSeats,
      live: true,
      captionHtml: esc('heartbeat under 2 min'),
      spark: miniBars(ops.liveSeries),
      formula: 'Seats with a heartbeat in the last 2 minutes',
      source: 'seats table, last_seen'
    }),
    ovTile({
      label: 'Seats',
      valueHtml: esc(String(ops.uniqueSessions)),
      flashKey: 'tile-seats',
      rawValue: ops.uniqueSessions,
      captionHtml: esc('unique seats, last 7 days'),
      spark: miniBars(ops.uniqueSeries),
      formula: 'Distinct seats seen at least once in the last 7 days',
      source: 'seats table, pulses, last 7 days'
    }),
    ovTile({
      label: 'Asks',
      valueHtml: esc(String(ops.apiCalls)),
      flashKey: 'tile-asks',
      rawValue: ops.apiCalls,
      captionHtml: esc('asks, last 7 days'),
      spark: miniBars(ops.apiSeries),
      formula: 'Asks logged fleet-wide in the last 7 days',
      source: 'asks table, last 7 days'
    }),
    ovTile({
      label: 'Asks per seat',
      valueHtml: esc(askPerSeat == null ? 'not reported' : askPerSeat.toFixed(1)),
      flashKey: 'tile-asks-seat',
      captionHtml: esc('asks divided by unique seats, 7 days'),
      formula: 'Asks in the last 7 days divided by unique seats in the last 7 days',
      source: 'asks table + seats table, last 7 days'
    }),
    ovTile({
      label: 'Recaps',
      valueHtml: esc(String(ops.recapCount)),
      flashKey: 'tile-recaps',
      rawValue: ops.recapCount,
      captionHtml: esc('recaps ingested, last 7 days'),
      spark: miniBars(ops.recapSeries),
      formula: 'Recap events ingested in the last 7 days',
      source: 'events table, kind = recap'
    }),
    ovTile({
      label: 'Time saved',
      valueHtml: esc(roi.timeSaved),
      flashKey: 'tile-time-saved',
      captionHtml: esc(roi.timeSavedSub),
      formula: 'Meeting time recap events report as saved',
      source: 'events table, kind = recap'
    }),
    renderValueTile(roi),
    ovTile({
      label: 'Live, 30 min',
      valueHtml: esc(String(roi.seats30m)),
      flashKey: 'tile-live30',
      rawValue: roi.seats30m,
      captionHtml: esc('seats seen in the last 30 min'),
      spark: `<svg class="ov-live30-svg" data-ov-live30-svg viewBox="0 0 104 28" preserveAspectRatio="none" aria-hidden="true" role="img" aria-label="Seats seen per minute, last 30 minutes"></svg>`,
      formula: 'Seats with a heartbeat in the last 30 minutes, sampled once per minute as this page stays open',
      source: 'live.json, polled every 5 s'
    })
  ]
  return `<div class="card mtiles-card mtiles-card-flush"><div class="mtiles-grid">${tiles.join('')}</div></div>`
}

// ---------------------------------------------------------------------------
// Tokens card (plan 3.7b law 4: a first-class Overview tile for token tracking).
// ---------------------------------------------------------------------------

/**
 * `DashboardPayload.cost.table` already sums cache-read, cache-write and uncached (the real
 * "tokens in": Anthropic's own docs call `input_tokens` "the uncached remainder", see
 * src/shared/operator.ts) tokens per provider over the last 7 days. Output tokens are used only
 * transiently inside `buildDashboard()`'s cost-estimate math and never summed into an exposed
 * field, so "out" is derived here as `ops.tokens` (the combined total over the same 7-day
 * `weekAsks` population, per `askTokenTotal` = cache_read + cache_write + cache_uncached +
 * output_tokens) minus the three components this page can read directly -- real arithmetic on
 * two real aggregates computed from the same rows, never an invented number. See the task
 * report's data-gap note: `dashboard.ts` should expose this split directly once it is worth the
 * shared-file change.
 */
function computeTokenParts(data: DashboardPayload): TokenParts | null {
  const table = data.cost.table
  let cacheRead = 0
  let cacheWrite = 0
  let tokensIn = 0
  let anyReported = false
  for (const row of table) {
    if (row.read != null) {
      cacheRead += row.read
      anyReported = true
    }
    if (row.write != null) {
      cacheWrite += row.write
      anyReported = true
    }
    if (row.uncached != null) {
      tokensIn += row.uncached
      anyReported = true
    }
  }
  if (!anyReported) return null
  const total = data.ops.tokens
  const tokensOut = total == null ? 0 : Math.max(0, total - (cacheRead + cacheWrite + tokensIn))
  return { in: tokensIn, out: tokensOut, cacheRead, cacheWrite }
}

function renderTokensCard(data: DashboardPayload): string {
  const parts = computeTokenParts(data)
  const cost = data.roi.cost7d
  const header = `<h3>Tokens${sourceTooltip('Tokens the fleet spent, by kind', 'asks table, last 7 days')}</h3>`
  if (!parts) {
    return `<article class="card pad-b10 ov-tokens-card" data-ov-tokens>
      <div class="kpi-top">${header}</div>
      ${emptyState({
        title: 'No token fields reported yet',
        description: 'Providers report token counts with each ask. None have arrived in the last 7 days.'
      })}
    </article>`
  }
  const total = parts.in + parts.out + parts.cacheRead + parts.cacheWrite
  const legendItem = (label: string, value: number, token: 1 | 2 | 3 | 4): string =>
    `<span class="ov-token-legend-item"><i class="ov-token-swatch ov-token-swatch-${token}" aria-hidden="true"></i>${esc(label)} <b data-flash-key="tile-tokens-${token}">${esc(formatCompact(value))}</b></span>`
  return `<article class="card pad-b10 ov-tokens-card" data-ov-tokens>
    <div class="kpi-top">${header}<span class="n ov-tokens-total" data-flash-key="tile-tokens-total">${esc(formatCompact(total))}</span></div>
    ${tokenStackBar(parts)}
    <div class="ov-token-legend">
      ${legendItem('In', parts.in, 1)}
      ${legendItem('Out', parts.out, 2)}
      ${legendItem('Cache read', parts.cacheRead, 3)}
      ${legendItem('Cache write', parts.cacheWrite, 4)}
    </div>
    <div class="sub ov-tokens-cost">Cost, last 7 days: ${cost ? esc(cost) : 'not reported'}</div>
  </article>`
}

// ---------------------------------------------------------------------------
// Unique seats area chart.
// ---------------------------------------------------------------------------

// height: 150 (default is 220) is the QA page-height budget trim (plan 3.7b #10): this chart's
// own function default stays taller for callers who want it, but at 1440 this card's SVG plus its
// header, ticks and card padding otherwise ran to nearly 270px for what a 7-point daily series
// draws as a nearly flat line -- kept in sync with the matching `.ov-area-chart` height in
// operator/src/spa/css-overview.ts, since the SVG's `preserveAspectRatio="none"` means whichever
// of the two disagrees stretches the chart instead of matching its own viewBox.
function renderAreaChartCard(data: DashboardPayload): string {
  const series = data.ops.uniqueSeries
  const now = data.now
  const labels = series.map((_, i) => {
    const t = now - (series.length - 1 - i) * DAY_MS
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(t))
  })
  return `<article class="card pad-b10 ov-area-card" data-ov-area-card>
    <div class="kpi-top"><h3>Unique seats${sourceTooltip('Distinct seats seen each day', 'seats table, pulses, last 7 days')}</h3></div>
    ${areaChartWithPrevious({ current: series, previous: null, labels, height: 110 })}
  </article>`
}

// ---------------------------------------------------------------------------
// Six top-list cards. Multi-tab cards reuse the exact `topListCard()` markup/classes
// (operator/src/render/top-list-card.ts) but render every tab's rows up front and switch which
// one is visible client-side (the shared primitive renders one table per call; a card with
// several tabs needs several row-sets sharing one tab strip, which is page composition, not a
// primitive change).
// ---------------------------------------------------------------------------

interface TlcRow {
  icon?: string
  label: string
  barValue?: number
  cells: Record<string, string>
  attrs?: string
  q?: string
}

interface TlcPane {
  id: string
  label: string
  labelHeader: string
  valueHeaders: TopListValueHeader[]
  rows: TlcRow[]
  emptyTitle: string
}

function renderPaneBody(pane: TlcPane): string {
  const colsClass = pane.valueHeaders.length >= 2 ? 'cols-2' : 'cols-1'
  const header = `<div class="tlc-row tlc-head ${colsClass}"><span>${esc(pane.labelHeader)}</span>${pane.valueHeaders.map((h) => `<span>${esc(h.label)}</span>`).join('')}</div>`
  const maxBar = Math.max(1, ...pane.rows.map((r) => r.barValue ?? 0))
  const rows = pane.rows.length
    ? pane.rows
        .map((r) => {
          const pct = maxBar > 0 ? Math.round(((r.barValue ?? 0) / maxBar) * 100) : 0
          const qAttr = r.q ? ` data-q="${esc(r.q)}"` : ''
          return `<div class="tlc-row ${colsClass}" data-stagger${qAttr} ${r.attrs || ''}>
            <svg class="row-bar" aria-hidden="true"><rect width="${pct}%" height="100%" data-grow/></svg>
            <span class="tlc-label">${r.icon || ''}<span>${esc(r.label)}</span></span>
            ${pane.valueHeaders.map((h) => `<span class="tlc-value">${r.cells[h.key] ?? ''}</span>`).join('')}
          </div>`
        })
        .join('')
    : `<div class="empty">${esc(pane.emptyTitle)}</div>`
  return `${header}${rows}`
}

function tabbedListCard(opts: { groupId: string; panes: TlcPane[]; searchPlaceholder?: string; defaultId?: string }): string {
  const activeIdx = Math.max(
    0,
    opts.panes.findIndex((p) => p.id === (opts.defaultId ?? opts.panes[0]?.id))
  )
  const tabsHtml = `<div class="tlc-tabs" role="tablist" data-ov-tlc-tabs="${esc(opts.groupId)}">${opts.panes
    .map(
      (p, i) =>
        `<button type="button" class="tlc-tab${i === activeIdx ? ' on' : ''}" role="tab" aria-selected="${i === activeIdx ? 'true' : 'false'}" data-ov-tlc-tab="${esc(opts.groupId)}:${esc(p.id)}">${esc(p.label)}</button>`
    )
    .join('')}</div>`
  const search = opts.searchPlaceholder
    ? `<div class="tlc-search"><input class="table-search" type="search" placeholder="${esc(opts.searchPlaceholder)}" autocomplete="off" data-ov-tlc-search="${esc(opts.groupId)}"></div>`
    : ''
  const panes = opts.panes
    .map(
      (p, i) =>
        `<div class="tlc-body" data-ov-tlc-pane="${esc(opts.groupId)}:${esc(p.id)}"${i === activeIdx ? '' : ' hidden'}>${renderPaneBody(p)}</div>`
    )
    .join('')
  const footer = `<div class="tlc-foot">${iconSvg(NAV_ICON_PATHS.search, { class: 'tool-ic' })}</div>`
  return `<div class="card tlc tlc-flush" data-ov-tlc-card="${esc(opts.groupId)}">${tabsHtml}${search}${panes}${footer}</div>`
}

/** Ask-kind events grouped by seat (hostname, falling back to email). Used to rank the Seats
 *  tab and as its "Asks" value column -- the payload has no per-seat ask count field, only the
 *  event feed, so this counts real `kind === 'ask'` events rather than inventing one. */
function buildAskCountsBySeat(data: DashboardPayload): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of data.events) {
    if (e.name !== 'ask' || looksLikeSecret(e.name)) continue
    const key = e.hostname || e.email || ''
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function renderSeatsCard(data: DashboardPayload): string {
  const askCounts = buildAskCountsBySeat(data)
  const seatRows: TlcRow[] = data.profiles
    .slice()
    .sort((a, b) => {
      const an = askCounts.get(a.hostname || a.email || '') ?? 0
      const bn = askCounts.get(b.hostname || b.email || '') ?? 0
      return bn - an || b.lastSeen - a.lastSeen
    })
    .slice(0, TLC_ROW_CAP)
    .map((r) => {
      const who = r.hostname || r.email || r.device
      const asks = askCounts.get(r.hostname || r.email || '') ?? 0
      return {
        icon: avatar({ name: r.hostname || '', email: r.email, live: r.live }),
        label: field(who),
        barValue: asks,
        cells: { asks: String(asks), live: statusDot({ state: r.live ? 'live' : 'idle', label: r.live ? 'Live' : 'Idle' }) },
        q: `${who} ${r.os} ${r.country || ''}`.toLowerCase(),
        attrs: `data-os="${esc(r.os)}" data-country="${esc(r.country || '')}" data-version="${esc(r.appVersion)}"`
      }
    })
  const osRows: TlcRow[] = data.scale.os.slice(0, TLC_ROW_CAP).map((r) => ({
    label: r.label,
    barValue: r.value,
    cells: { count: String(r.value) },
    q: r.label.toLowerCase()
  }))
  const versionRows: TlcRow[] = data.scale.versions.slice(0, TLC_ROW_CAP).map((r) => ({
    label: r.label,
    barValue: r.value,
    cells: { count: String(r.value) },
    q: r.label.toLowerCase()
  }))
  return tabbedListCard({
    groupId: 'seats',
    searchPlaceholder: 'Search seats',
    panes: [
      {
        id: 'seats',
        label: 'Seats',
        labelHeader: 'Seat',
        valueHeaders: [
          { key: 'asks', label: 'Asks' },
          { key: 'live', label: 'Live' }
        ],
        rows: seatRows,
        emptyTitle: 'No seats have checked in yet. A seat appears within 60 seconds of its first heartbeat.'
      },
      {
        id: 'os',
        label: 'OS',
        labelHeader: 'OS',
        valueHeaders: [{ key: 'count', label: 'Seats' }],
        rows: osRows,
        emptyTitle: 'No OS mix yet.'
      },
      {
        id: 'version',
        label: 'Version',
        labelHeader: 'Version',
        valueHeaders: [{ key: 'count', label: 'Seats' }],
        rows: versionRows,
        emptyTitle: 'No version mix yet.'
      }
    ]
  })
}

function renderAsksCard(data: DashboardPayload): string {
  const q = data.questions
  const totalModes = Math.max(1, q.byMode.reduce((s, m) => s + m.mix.total, 0))
  const modeRows: TlcRow[] = q.byMode.slice(0, TLC_ROW_CAP).map((m) => ({
    label: m.mode || 'unknown',
    barValue: m.mix.total,
    cells: { asks: String(m.mix.total), share: `${Math.round((m.mix.total / totalModes) * 100)}%` },
    q: (m.mode || '').toLowerCase()
  }))
  const totalTypes = Math.max(1, q.mix.bars.reduce((s, b) => s + b.count, 0))
  const typeRows: TlcRow[] = q.mix.bars.slice(0, TLC_ROW_CAP).map((b) => ({
    label: b.label,
    barValue: b.count,
    cells: { asks: String(b.count), share: `${Math.round((b.count / totalTypes) * 100)}%` },
    q: b.label.toLowerCase()
  }))
  const totalProviders = Math.max(1, data.gateway.rows.reduce((s, p) => s + p.asks, 0))
  const providerRows: TlcRow[] = data.gateway.rows.slice(0, TLC_ROW_CAP).map((p) => ({
    label: p.provider,
    barValue: p.asks,
    cells: { asks: String(p.asks), share: `${Math.round((p.asks / totalProviders) * 100)}%` },
    q: p.provider.toLowerCase()
  }))
  const valueHeaders: TopListValueHeader[] = [
    { key: 'asks', label: 'Asks' },
    { key: 'share', label: 'Share' }
  ]
  return tabbedListCard({
    groupId: 'asks',
    searchPlaceholder: 'Search asks',
    panes: [
      { id: 'modes', label: 'Modes', labelHeader: 'Mode', valueHeaders, rows: modeRows, emptyTitle: 'No asks logged yet.' },
      { id: 'types', label: 'Question types', labelHeader: 'Type', valueHeaders, rows: typeRows, emptyTitle: 'No question type reported yet.' },
      { id: 'providers', label: 'Providers', labelHeader: 'Provider', valueHeaders, rows: providerRows, emptyTitle: 'No provider usage yet.' }
    ]
  })
}

function renderEventsCard(data: DashboardPayload): string {
  const counts = new Map<string, number>()
  for (const e of data.events) {
    const name = looksLikeSecret(e.name) ? 'event' : e.name
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  // kindBadge() already carries the readable label (icon + "Ask" / "Recap" / ...), so the row's
  // own text label stays empty rather than repeating the same word a second time in plain text.
  const rows: TopListRow[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TLC_ROW_CAP)
    .map(([name, n]) => ({ icon: kindBadge(name), label: '', barValue: n, cells: { count: String(n) } }))
  return topListCard({
    labelHeader: 'Kind',
    valueHeaders: [{ key: 'count', label: 'Count' }],
    rows,
    emptyTitle: 'No events yet. A heartbeat writes the first one.'
  })
}

/** "States" (real: every seat's `approval`) is the default pane. "Tiers" has no honest source in
 *  this payload today -- `licenses.rows`/`licenses.issued` carry no `tier` field even though the
 *  store layer's `IssuedLicenseRow.tier` exists (see the task report's data-gap note) -- so it
 *  renders a named empty state rather than a guess (plan lock 3). */
function renderLicensesCard(data: DashboardPayload): string {
  const stateCounts = new Map<string, number>()
  for (const s of data.licenses.rows) {
    const k = s.approval || 'pending'
    stateCounts.set(k, (stateCounts.get(k) ?? 0) + 1)
  }
  const stateRows: TlcRow[] = [...stateCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, n]) => ({
      icon: statusDot({ state: state === 'approved' ? 'live' : state === 'revoked' ? 'revoked' : 'pending', label: '' }),
      label: state.charAt(0).toUpperCase() + state.slice(1),
      barValue: n,
      cells: { seats: String(n) },
      q: state
    }))
  return tabbedListCard({
    groupId: 'licenses',
    defaultId: 'states',
    panes: [
      {
        id: 'tiers',
        label: 'Tiers',
        labelHeader: 'Tier',
        valueHeaders: [{ key: 'seats', label: 'Seats' }],
        rows: [],
        emptyTitle: 'Tier is not tracked per seat in this payload yet.'
      },
      {
        id: 'states',
        label: 'States',
        labelHeader: 'State',
        valueHeaders: [{ key: 'seats', label: 'Seats' }],
        rows: stateRows,
        emptyTitle: 'No licensed seats yet.'
      }
    ]
  })
}

function renderCountriesCard(data: DashboardPayload): string {
  const countries = geoCountryRollup(data.geo)
  const nameOf = (iso: string): string => COUNTRY_NAMES[iso.toUpperCase()] || iso
  const countryRows: TlcRow[] = countries.slice(0, TLC_ROW_CAP).map((r) => ({
    icon: flag(r.country),
    label: nameOf(r.country),
    barValue: r.count,
    cells: { seats: String(r.count), sessions: String(r.unique_sessions) },
    q: `${r.country} ${nameOf(r.country)}`.toLowerCase(),
    attrs: `data-country="${esc(r.country)}"`
  }))
  const regionRows: TlcRow[] = data.geoRegions.slice(0, TLC_ROW_CAP).map((r) => ({
    label: `${r.region}, ${nameOf(r.country)}`,
    barValue: r.count,
    cells: { seats: String(r.count), sessions: String(r.unique_sessions) },
    q: `${r.region} ${r.country}`.toLowerCase()
  }))
  const cityRows: TlcRow[] = data.geo.slice(0, TLC_ROW_CAP).map((r) => ({
    icon: flag(r.country),
    label: r.city || 'Country only',
    barValue: r.count,
    cells: { seats: String(r.count), sessions: String(r.unique_sessions) },
    q: `${r.city} ${r.country}`.toLowerCase()
  }))
  const valueHeaders: TopListValueHeader[] = [
    { key: 'seats', label: 'Seats' },
    { key: 'sessions', label: 'Sessions' }
  ]
  return tabbedListCard({
    groupId: 'countries',
    searchPlaceholder: 'Search places',
    panes: [
      { id: 'countries', label: 'Countries', labelHeader: 'Country', valueHeaders, rows: countryRows, emptyTitle: 'No country geo yet. A heartbeat writes request.cf country.' },
      { id: 'regions', label: 'Regions', labelHeader: 'Region', valueHeaders, rows: regionRows, emptyTitle: 'No region geo yet. A heartbeat writes request.cf region.' },
      { id: 'cities', label: 'Cities', labelHeader: 'City', valueHeaders, rows: cityRows, emptyTitle: 'No city geo yet. A heartbeat writes request.cf city.' }
    ]
  })
}

// ---------------------------------------------------------------------------
// Connectors card (plan 6.2, 2026-09-06: "the 6.10b list block in col-span-3 ... sits next to the
// Countries card so the Overview answers 'what is connected and what needs me' without a page
// change"). DashboardPayload carries no connector rows at all -- operator/src/render/pages/
// connectors.ts's own top comment documents the same gap for the full Connectors page and solves
// it the same way this card does: render the card shell with a named loading skeleton on first
// paint (never a fake row), then operator/client/pages/overview.ts's initOverview() fetches the
// same GET /v1/admin/integrations route the Connectors page already uses and fills it in through
// the pure, exported renderConnectorsCardRows() below -- the function this file's test and that
// client call both exercise identically (plan D2).
//
// This card reuses connectorRow() from operator/src/render/connectors-list.ts (the shared 6.10b
// row primitive: logo tile + corner status dot, name + MCP/API badge, the reason or tool-count
// secondary line, one word action link) for every row, but not that module's own connectorGroup()
// wrapper: plan 6.2 says this card's overflow reads "Show N more" *linking to #connectors*, not
// connectorGroup()'s in-place FLIP expand (that behaviour is for the full Connectors page, plan
// 6.10b, a different task's file). renderConnectorGroupCard() below is the same small group-card
// shape connectorGroup() renders, capped at three rows (plan 6.2: "at most three rows each") with
// a plain anchor for the rest, so nothing past three ever reaches the DOM on this compact card.
// ---------------------------------------------------------------------------

/** Overview's own input shape for one connector: enough to build a 6.10b row (plan 6.10b's
 *  `ConnectorRow` minus the fields only the full Connectors page's click-to-authenticate flow
 *  needs). `healthy` maps to the emerald/rose status dot; `reason` and `toolsCount` are ignored
 *  the other way round (a healthy row never shows a reason, a needs-attention row never shows a
 *  tool count), same rule connectorRow() itself already enforces. */
export interface OverviewConnectorSummary {
  id: string
  kind: string
  label: string
  transport: ConnectorTransport
  healthy: boolean
  reason?: string
  toolsCount?: number
}

function toConnectorCardRow(row: OverviewConnectorSummary): ConnectorRow {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    transport: row.transport,
    status: row.healthy ? 'connected' : 'attention',
    // Overview's compact card never opens the full connection drawer itself (that flow, and the
    // auth-kind branching it needs, belongs to operator/src/render/pages/connectors.ts) -- every
    // row and every "Show more" link here takes the seat to #connectors instead, so the one-word
    // action names what the row invites, not which flow the click will run.
    action: row.healthy ? 'Test' : 'Fix',
    auth: 'view-in-connectors',
    reason: row.reason,
    toolsCount: row.toolsCount
  }
}

/** Same group-card shape connectorGroup() renders (plan 6.10b), capped at three rows and an
 *  anchor instead of an in-place expand (see the block comment above). An empty group renders
 *  nothing, matching connectorGroup()'s own rule: a zero count never gets a card. */
function renderConnectorGroupCard(title: string, rows: ConnectorRow[]): string {
  if (!rows.length) return ''
  const limit = 3
  const visible = rows.slice(0, limit)
  const moreCount = rows.length - limit
  const more = moreCount > 0 ? `<a class="connector-show-more" href="#connectors">Show ${moreCount} more</a>` : ''
  return `<article class="card pad-b10 connector-group" data-connector-group>
    <div class="connector-group-head"><h3>${esc(title)} <span class="connector-group-count">${rows.length}</span></h3></div>
    <div class="connector-group-rows" data-connector-rows>${visible.map((r) => connectorRow(r)).join('')}</div>
    ${more}
  </article>`
}

/** Pure: "Needs attention" then "Connected" (plan 6.10b order), built from real rows only. Used
 *  by this page's client (real GET /v1/admin/integrations rows) and by this file's own test
 *  (fixture rows from overview.fixture.ts) so both render byte-identical markup. */
export function renderConnectorsCardRows(rows: OverviewConnectorSummary[]): string {
  const built = rows.map(toConnectorCardRow)
  const attention = built.filter((r) => r.status === 'attention')
  const connected = built.filter((r) => r.status === 'connected')
  const html = `${renderConnectorGroupCard('Needs attention', attention)}${renderConnectorGroupCard('Connected', connected)}`
  if (!html) {
    return `<article class="card pad-b10 connector-group">${emptyState({
      title: 'No connectors yet.',
      description: 'Connect a CRM, a work tool or an MCP server from the Connectors page.'
    })}</article>`
  }
  return html
}

function renderConnectorsSkeleton(): string {
  return `<div class="card pad-b10 connector-group" role="status" aria-label="Loading connectors">${skeletonRows(3)}</div>`
}

function renderConnectorsCard(_data: DashboardPayload): string {
  return `<div class="ov-connectors-card" data-ov-connectors-card>
    <div data-ov-connectors-root data-ov-connectors-state="loading">${renderConnectorsSkeleton()}</div>
    <p class="ov-connectors-error muted" data-ov-connectors-error hidden role="alert"></p>
  </div>`
}

/**
 * Corner choropleth (plan brief: reuse `charts.ts`'s `choroplethMini()` exactly as it stands,
 * wrapped in this page's own container, recoloured by CSS class through
 * `recolorChoroplethMini()`, plan 3.2 `--chart-scale-01..05`). `renderCornerMapSvg`
 * (operator/src/world/map.ts) already stamps `data-iso` on every land path, so no fallback
 * hand-drawn map is needed.
 */
function renderMapCard(data: DashboardPayload): string {
  const svg = recolorChoroplethMini(choroplethMini(data.map.countries, 'ov-map-svg'), data.map.countries)
  const legend = `<div class="ov-map-legend" aria-hidden="true">
    <span class="ov-map-legend-label">Fewer seats</span>
    ${[0, 1, 2, 3, 4, 5].map((n) => `<i class="ov-map-swatch ov-map-scale-${n}"></i>`).join('')}
    <span class="ov-map-legend-label">More seats</span>
  </div>`
  const empty = data.map.empty
    ? `<p class="empty ov-map-empty">No seat has checked in yet. The map fills in as heartbeats arrive.</p>`
    : ''
  return `<article class="card pad-b10 ov-map-card" data-ov-map-card>
    <div class="kpi-top"><h3>Map${sourceTooltip('Seats per country in the fleet', 'seats table, current')}</h3></div>
    <div class="ov-map-frame">${svg}</div>
    ${empty}
    ${legend}
  </article>`
}

// ---------------------------------------------------------------------------
// Generate license card.
// ---------------------------------------------------------------------------

function renderGenerateLicenseCard(): string {
  return `<article class="card pad-b10 ov-license-card" data-ov-license-card>
    <div class="kpi-top"><h3>Generate license</h3></div>
    <p class="sub muted">Pick how long it stays active. Paste the string into Métis, Identity, License. Shown once, last4 after that.</p>
    <form class="ov-license-form" data-license-generate method="post" action="/v1/admin/licenses/generate" autocomplete="off">
      <label class="ov-license-field">Active for
        <select name="days" required>
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30" selected>30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
      </label>
      <button class="btn primary" type="submit">Generate license</button>
    </form>
    <div class="ov-license-once" hidden data-license-once>
      <p class="sub">Copy this once. It will not be shown again.</p>
      <div class="ov-license-once-row">
        <input class="ov-license-once-value" data-license-once-value readonly spellcheck="false" aria-label="Generated license">
        <button type="button" class="btn primary" data-license-once-copy>Copy</button>
      </div>
    </div>
  </article>`
}
