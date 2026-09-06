import { choroplethMini, sparklineArea, sparklineLine } from './charts'
import type { DashboardPayload } from './dashboard'
import { formatValueEur, HOURLY_RATE_EUR } from './value'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 100) / 10}K`
  return String(n)
}

function reported(value: string | number | null | undefined): string {
  if (value == null) return '0'
  if (typeof value === 'number') return formatCompact(value)
  return value
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '0'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function formatPct(n: number | null): string {
  if (n == null) return '0%'
  return `${n}%`
}

function trend(values: number[], current?: number): { text: string; cls: string } | null {
  if (current === 0) return null
  if (values.length < 4) return null
  const mid = Math.floor(values.length / 2)
  const a = values.slice(0, mid).reduce((n, v) => n + v, 0) / mid
  const b = values.slice(mid).reduce((n, v) => n + v, 0) / (values.length - mid)
  if (a < 1) return null
  const pct = ((b - a) / a) * 100
  if (!Number.isFinite(pct) || Math.abs(pct) > 400) return null
  const rounded = Math.abs(pct) < 0.05 ? 0 : Math.round(pct * 10) / 10
  if (rounded === 0) return null
  return { text: `${rounded > 0 ? '+' : ''}${rounded}%`, cls: rounded > 0 ? 'up' : 'down' }
}

function gaugeSvg(n: number, max: number): string {
  const t = max <= 0 ? 0 : Math.min(1, n / max)
  const r = 34
  const c = Math.PI * r
  const dash = (t * c).toFixed(1)
  return `<svg class="stat-spark stat-gauge" viewBox="0 0 88 56" aria-hidden="true">
    <path d="M10 48 A 34 34 0 0 1 78 48" fill="none" stroke="#EDEDED" stroke-width="8" stroke-linecap="round"/>
    <path d="M10 48 A 34 34 0 0 1 78 48" fill="none" stroke="#2563EB" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dash} ${c.toFixed(1)}"/>
  </svg>`
}

function ringSvg(portion: number, empty = false): string {
  const r = 22
  const c = 2 * Math.PI * r
  const t = empty ? 0 : Math.max(0, Math.min(1, portion))
  const dash = (t * c).toFixed(1)
  return `<svg class="stat-spark stat-ring" viewBox="0 0 64 56" aria-hidden="true">
    <circle cx="32" cy="28" r="${r}" fill="none" stroke="#EDEDED" stroke-width="7"/>
    <circle cx="32" cy="28" r="${r}" fill="none" stroke="#2563EB" stroke-width="7"
      stroke-dasharray="${dash} ${c.toFixed(1)}" stroke-linecap="round" transform="rotate(-90 32 28)"/>
  </svg>`
}

function splitRing(a: number, b: number): string {
  const total = a + b
  if (!total) return ringSvg(0, true)
  const r = 22
  const c = 2 * Math.PI * r
  const aDash = ((a / total) * c).toFixed(1)
  const bDash = ((b / total) * c).toFixed(1)
  return `<svg class="stat-spark stat-ring" viewBox="0 0 64 56" aria-hidden="true">
    <circle cx="32" cy="28" r="${r}" fill="none" stroke="#EDEDED" stroke-width="7"/>
    <circle cx="32" cy="28" r="${r}" fill="none" stroke="#2563EB" stroke-width="7"
      stroke-dasharray="${aDash} ${c.toFixed(1)}" transform="rotate(-90 32 28)"/>
    <circle cx="32" cy="28" r="${r}" fill="none" stroke="#93C5FD" stroke-width="7"
      stroke-dasharray="${bDash} ${c.toFixed(1)}" stroke-dashoffset="-${aDash}" transform="rotate(-90 32 28)"/>
  </svg>`
}

function statCard(opts: {
  id: string
  title: string
  value: string
  unit: string
  kind: 'area' | 'line' | 'gauge' | 'ring' | 'choropleth' | 'live-line'
  series: number[]
  chart: string
}): string {
  const current = Number(opts.value.replace(/[^\d.-]/g, ''))
  const d = trend(opts.series, Number.isFinite(current) ? current : undefined)
  return `<article class="stat-card" data-stat-card="${esc(opts.id)}" data-bklit="${esc(opts.kind)}">
    <div class="stat-card-head">
      <h3>${esc(opts.title)}</h3>
      ${d ? `<span class="trend-badge ${d.cls}">${esc(d.text)}</span>` : ''}
    </div>
    <div class="stat-flow">
      <div class="n">${esc(opts.value)}</div>
      <div class="lbl">${esc(opts.unit)}</div>
    </div>
    ${opts.chart}
  </article>`
}

function chip(label: string, value: string): string {
  return `<span class="ov-chip"><b>${esc(label)}</b> ${esc(value)}</span>`
}

/** Issue 106: exactly 10 Bklit mini KPI cards from live heartbeats. 0 LLM tokens. */
export function renderOverviewMini10(data: DashboardPayload): string {
  const ops = data.ops
  const countries = data.map.countries
  const countryCount = countries.length
  const cli = ops.cliAsks
  const op = ops.operatorAsks
  const cards = [
    statCard({
      id: 'unique-sessions',
      title: 'Unique sessions',
      value: formatCompact(ops.uniqueSessions),
      unit: 'WAU',
      kind: 'area',
      series: ops.uniqueSeries,
      chart: sparklineArea(ops.uniqueSeries, 280, 72)
    }),
    statCard({
      id: 'sessions-day',
      title: 'Sessions / day',
      value: formatCompact(ops.sessionsDay),
      unit: 'DAU',
      kind: 'line',
      series: ops.sessionsDaySeries,
      chart: sparklineLine(ops.sessionsDaySeries, 280, 72)
    }),
    statCard({
      id: 'live-now',
      title: 'Live now',
      value: formatCompact(ops.liveNow),
      unit: 'seats',
      kind: 'gauge',
      series: ops.liveSeries,
      chart: gaugeSvg(ops.liveNow, Math.max(ops.liveNow, ops.live30, ops.uniqueSessions, 1))
    }),
    statCard({
      id: 'time-saved',
      title: 'Time saved',
      value: reported(ops.timeSaved),
      unit: 'seat-local',
      kind: 'ring',
      series: [],
      chart: ringSvg(0, true)
    }),
    statCard({
      id: 'value',
      title: 'Value',
      value: formatValueEur(ops.valueEur || 0),
      unit: `at €${HOURLY_RATE_EUR}/hr`,
      kind: 'area',
      series: [],
      chart: sparklineArea([], 280, 72)
    }),
    statCard({
      id: 'tokens',
      title: 'Tokens',
      value: reported(ops.tokens),
      unit: 'tokens',
      kind: 'area',
      series: ops.tokenSeries,
      chart: sparklineArea(ops.tokenSeries, 280, 72)
    }),
    statCard({
      id: 'api-calls',
      title: 'API calls',
      value: formatCompact(ops.apiCalls),
      unit: 'asks',
      kind: 'line',
      series: ops.apiSeries,
      chart: sparklineLine(ops.apiSeries, 280, 72)
    }),
    statCard({
      id: 'recaps',
      title: 'Recaps',
      value: formatCompact(ops.recapCount),
      unit: 'recap',
      kind: 'line',
      series: ops.recapSeries,
      chart: sparklineLine(ops.recapSeries, 280, 72)
    }),
    statCard({
      id: 'cli-vs-key',
      title: 'CLI vs Operator-key asks',
      value: `${cli} / ${op}`,
      unit: 'cli · key',
      kind: 'ring',
      series: [],
      chart: splitRing(cli, op)
    }),
    statCard({
      id: 'countries',
      title: 'Countries',
      value: formatCompact(countryCount),
      unit: 'total',
      kind: 'choropleth',
      series: [],
      chart: `<div class="stat-choro-wrap">${choroplethMini(countries)}</div>`
    })
  ]
  const cost = data.kpis.cost7d ?? '0'
  const chips = [
    chip('Mac vs Windows', data.scale.os.map((o) => `${o.label} ${o.value}`).join(' · ') || '0'),
    chip('Cost by provider', cost),
    chip('CRM fail', formatPct(ops.crmFailRate)),
    chip('Version mix', data.scale.versions.map((v) => `${v.label} ${v.value}`).join(' · ') || '0'),
    chip('Duration', formatDuration(ops.durationMs)),
    chip('Meetings', formatCompact(ops.meetings)),
    chip('Live · 30 min', formatCompact(ops.live30)),
    chip('CLI asks', formatCompact(cli)),
    chip('Operator-key asks', formatCompact(op))
  ].join('')
  const usage = data.usageWindow
  const landed = Boolean(usage && (ops.tokens || ops.apiCalls || usage.tokens || usage.count))
  const hero = `<header class="ov-hero" data-overview-hero>
      <div class="ov-brand">
        <span class="ov-mark" aria-hidden="true"></span>
        <span class="ov-brand-name">Operator</span>
      </div>
      <p class="ov-headline">Fleet pulse · value at €${HOURLY_RATE_EUR}/hr</p>
      <p class="ov-lede">Live seats, time saved, and EBITDA proxy at €${HOURLY_RATE_EUR}/hr. Numbers stay empty until heartbeats land — never sample.</p>
    </header>`
  const liveBanner = usage
    ? `<div class="ov-live ov-live-landed" data-usage-landed="${landed ? '1' : '0'}" data-usage-from="${esc(usage.from)}" data-usage-to="${esc(usage.to)}" data-usage-provider="deepseek">
        <div class="ov-live-main">
          <span class="ov-live-dot" aria-hidden="true"></span>
          <span class="ov-live-label">DeepSeek usage imported</span>
          <span class="ov-live-range">${esc(usage.from)} → ${esc(usage.to)}</span>
        </div>
        <div class="ov-live-stats" data-usage-stats="1">
          <span class="ov-live-stat" data-usage-stat="asks"><b>${esc(formatCompact(usage.count))}</b> asks</span>
          <span class="ov-live-stat" data-usage-stat="tokens"><b>${esc(formatCompact(usage.tokens))}</b> tokens</span>
          <span class="ov-live-stat" data-usage-stat="cost"><b>$${usage.costUsd.toFixed(2)}</b> billed</span>
        </div>
      </div>`
    : `<div class="ov-live ov-live-idle" data-usage-landed="0">
        <span class="ov-live-dot" aria-hidden="true"></span>
        <span class="ov-live-label">Waiting on usage</span>
        <span class="ov-live-meta">Heartbeats and asks fill this strip when they land</span>
      </div>`
  const cardsHtml = cards
    .map((html) => {
      if (!landed) return html
      if (html.includes('data-stat-card="tokens"') || html.includes('data-stat-card="api-calls"')) {
        return html.replace('class="stat-card"', 'class="stat-card stat-card-landed"')
      }
      return html
    })
    .join('')
  return `${hero}
    ${liveBanner}
    <div class="ov-10" data-overview-cards="10" data-overview-job="live-kpis">${cardsHtml}</div>
    <div class="ov-chips" data-overview-secondary="1">${chips}</div>`
}
