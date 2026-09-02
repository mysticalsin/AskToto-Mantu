import { minuteBars, shoeyWorld } from './charts'
import { countryName, flagMark, osChip, osLabel } from './countries'
import type { ConsoleEvent, DashboardPayload, MapVolumeRow } from './dashboard'
import { looksLikeSecret } from './redact'

const MISSING = '—'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
}

export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`
  const h = Math.floor(m / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.floor(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

function field(value: string | null | undefined): string {
  if (!value || looksLikeSecret(value)) return MISSING
  return esc(value)
}

function volumeCell(n: number, max: number): string {
  const pct = max > 0 ? Math.round((n / max) * 100) : 0
  return `<td class="vol-cell"><span class="vol-bar" style="width:${pct}%"></span><span class="vol-n">${n}</span></td>`
}

function volumeTable(
  hook: string,
  title: string,
  sub: string,
  rows: MapVolumeRow[],
  empty: string,
  marks: string
): string {
  const maxEvents = Math.max(0, ...rows.map((r) => r.events))
  const maxSeats = Math.max(0, ...rows.map((r) => r.seats))
  const body = rows
    .map((r) => {
      const mark = r.country ? flagMark(r.country) : esc(r.mark.slice(0, 3))
      return `<tr data-country="${esc(r.country || '')}" data-key="${esc(r.key)}">
        <td class="vol-place"><span class="mark" aria-hidden="true">${mark}</span>${esc(r.label)}</td>
        ${volumeCell(r.events, maxEvents)}
        ${volumeCell(r.seats, maxSeats)}
      </tr>`
    })
    .join('')
  return `<article class="card map-table" data-map-${hook}>
    <div class="map-table-head">
      <div>
        <h3>${esc(title)}</h3>
        <p class="map-sub">${esc(sub)}</p>
      </div>
      <div class="map-table-marks">${marks}</div>
    </div>
    ${
      rows.length
        ? `<table class="vol"><thead><tr><th>${esc(title)}</th><th>Events</th><th>Seats</th></tr></thead><tbody>${body}</tbody></table>`
        : `<div class="empty">${esc(empty)}</div>`
    }
  </article>`
}

function streamRow(e: ConsoleEvent, now: number): string {
  const name = looksLikeSecret(e.name) ? 'event' : e.name
  const who = e.hostname || e.email || null
  const os = e.chips.find((c) => c.key === 'os')?.value
  const country = e.chips.find((c) => c.key === 'country')?.value
  return `<div class="activity" data-event="${esc(e.id)}" data-country="${esc(country || '')}">
    <div class="activity-name">${esc(name)}</div>
    <div class="activity-who">${field(who)}</div>
    <div class="activity-meta">
      <span class="activity-time">${esc(relTime(e.ts, now))}</span>
      ${os ? `<span class="os-chip">${esc(osChip(os))}</span>` : ''}
      ${country ? `<span class="mark" title="${esc(countryName(country))}">${flagMark(country)}</span>` : ''}
    </div>
  </div>`
}

export function renderMapPage(data: DashboardPayload): string {
  const m = data.map
  const caption =
    'Unique seats by country and city from Cloudflare request.cf. No GPS from the app. No IP. Click a country to filter Geo. Empty is an empty world, not sample dots.'
  const world = shoeyWorld(m.countries, m.dots, m.labels)
  const emptyMap = m.empty
    ? '<div class="empty map-empty">No heartbeats yet. The map stays empty until a seat checks in.</div>'
    : ''
  const stream = m.stream.length
    ? m.stream.map((e) => streamRow(e, data.now)).join('')
    : '<div class="empty">No seat events yet.</div>'
  const geoMarks = [...new Set(m.geo.map((r) => r.country).filter(Boolean))]
    .slice(0, 8)
    .map((iso) => `<span class="mark">${flagMark(iso)}</span>`)
    .join('')
  const refMarks = m.referrals
    .slice(0, 6)
    .map((r) => `<span class="os-chip">${esc(r.mark.slice(0, 8))}</span>`)
    .join('')
  const pathMarks = m.paths
    .slice(0, 6)
    .map((r) => `<span class="os-chip">${esc(r.label.slice(0, 8))}</span>`)
    .join('')
  const refSub = m.referralKind === 'provider' ? 'LLM providers from real Asks' : 'macOS vs Windows from seats'
  const pathSub = m.pathKind === 'skill' ? 'Skills from real Asks' : 'Event kinds from real ingest'
  return `
    <section class="page wrap map-page" data-page="map" hidden>
      <div class="map-hero">
        <div class="map-live-col">
          <article class="card map-count-card" data-map-live>
            <p class="map-kicker">Unique seats last 30 min</p>
            <div class="map-count" data-map-count>${m.uniqueSeats30m}</div>
            ${minuteBars(m.bars30m)}
          </article>
          <article class="card map-stream-card">
            <p class="map-kicker">Live activity</p>
            <div class="activity-list">${stream}</div>
          </article>
        </div>
        <article class="card map-world-card" data-map-world>
          <div id="map-root" class="map-root">
            ${emptyMap}
            ${world}
          </div>
          <div class="sub muted map-caption">${esc(caption)}</div>
        </article>
      </div>
      <div class="map-tables">
        ${volumeTable('geo', 'Geo', 'Country / city of seats', m.geo, 'No seats with a country yet.', geoMarks)}
        ${volumeTable(
          'referrals',
          'Referrals',
          refSub,
          m.referrals,
          'No provider or OS mix yet.',
          refMarks
        )}
        ${volumeTable('paths', 'Paths', pathSub, m.paths, 'No skills or event kinds yet.', pathMarks)}
      </div>
    </section>`
}

export const MAP_PAGE_CSS = `
.map-page { gap: 12px; }
.map-hero { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 12px; align-items: stretch; }
.map-live-col { display: grid; grid-template-rows: auto 1fr; gap: 12px; min-width: 0; }
.map-count-card { padding: 14px 14px 10px; }
.map-kicker { margin: 0; font-size: 12px; color: var(--ink2); font-weight: 500; }
.map-count { font-size: 40px; font-weight: 700; letter-spacing: -0.05em; line-height: 1; margin: 10px 0 12px; color: var(--ink); }
.min-bars { display: block; width: 100%; height: 44px; }
.min-bar { fill: #3B82F6; }
.map-stream-card { padding: 12px 12px 8px; min-height: 0; }
.activity-list { max-height: 420px; overflow: auto; }
.activity {
  display: grid; grid-template-columns: 72px 1fr auto; gap: 8px; align-items: center;
  padding: 8px 2px; border-bottom: 1px solid var(--hair); font-size: 12px;
}
.activity-name { font-weight: 650; }
.activity-who { color: var(--ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-meta { display: flex; align-items: center; gap: 6px; color: var(--ink3); font-size: 11px; }
.activity-time { font-family: var(--mono); font-size: 10px; color: var(--ink3); }
.os-chip {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; padding: 1px 5px; border-radius: 4px;
  border: 1px solid var(--hair); font: 10px/1.3 var(--mono); color: var(--ink2); text-transform: lowercase;
}
.mark { font-size: 14px; line-height: 1; }
.map-world-card { padding: 8px 8px 4px; }
.map-root { position: relative; min-height: 280px; }
.shoey-world { display: block; width: 100%; height: auto; max-height: 520px; }
:root { --map-land: #E5E7EB; }
[data-theme="dark"] { --map-land: #3f3f46; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --map-land: #3f3f46; }
}
[data-theme="light"] { --map-land: #E5E7EB; }
.dot { fill: #1e3a5f; stroke: #fff; stroke-width: 0.7; }
[data-theme="dark"] .dot { stroke: #111113; }
.map-leader { stroke: #9ca3af; stroke-width: 0.8; fill: none; }
.map-label-dot { fill: #0F766E; }
.map-label-n { fill: #fff; font: 700 9px var(--sans); }
.map-label-name { fill: #0F766E; font: 600 11px var(--sans); }
.map-caption { padding: 4px 6px 8px; }
.map-tables { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.map-table { padding: 12px 12px 8px; }
.map-table-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.map-table h3 { margin: 0; font-size: 14px; font-weight: 650; }
.map-sub { margin: 2px 0 0; font-size: 11px; color: var(--ink3); }
.map-table-marks { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.vol th { font-size: 10px; }
.vol-place { display: flex; align-items: center; gap: 6px; }
.vol-cell { position: relative; font-variant-numeric: tabular-nums; }
.vol-bar {
  position: absolute; left: 0; bottom: 4px; height: 3px; background: #E5E7EB; border-radius: 99px;
  pointer-events: none;
}
[data-theme="dark"] .vol-bar { background: #3f3f46; }
.vol-n { position: relative; z-index: 1; }
@media (max-width: 1100px) {
  .map-hero, .map-tables { grid-template-columns: 1fr; }
}
`
