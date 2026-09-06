/**
 * Small, atomic render primitives shared by every section page. Pure functions, no DOM,
 * `esc()` on every interpolated value. See operator/src/render/README.md (plan D2).
 */
import { esc } from './index'
import { COUNTRY_NAMES } from './countries'
import { iconSvg, KIND_ICON_PATHS, OS_ICON_PATHS } from './icons'

/** 1,234,567 -> "1.2M". Never invents precision the source data does not have. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}${trimZero((abs / 1_000_000_000).toFixed(1))}B`
  if (abs >= 1_000_000) return `${sign}${trimZero((abs / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${sign}${trimZero((abs / 1_000).toFixed(1))}K`
  return `${sign}${Math.round(abs)}`
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** ts vs now -> "now" / "42s" / "3m" / "5h" / "2d". Floors at 0, never negative. */
export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** relativeTime(), wrapped with the absolute UTC instant in `title` and `data-ts` so a client
 * ticker can re-render it every second without a re-fetch. */
export function timeCell(ts: number, now: number): string {
  const iso = new Date(ts).toISOString()
  return `<time class="time-cell" datetime="${esc(iso)}" data-ts="${ts}" title="${esc(iso.replace('T', ' ').slice(0, 19))} UTC">${esc(relativeTime(ts, now))}</time>`
}

/** Emoji regional-indicator flag for an ISO 3166-1 alpha-2 code, with the country name in a
 * title (never color alone: `aria-label` carries the same name for screen readers). Unknown
 * codes render as plain text, never a fabricated flag. */
export function flag(iso: string | null | undefined): string {
  const code = String(iso || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ''
  const name = COUNTRY_NAMES[code] || code
  const glyph = String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)))
  return `<span class="flag" title="${esc(name)}" aria-label="${esc(name)}" role="img">${glyph}</span>`
}

/** OS glyph plus label. Never a fake device signal Métis does not collect. */
export function osGlyph(os: string | null | undefined): { glyph: string; label: string } {
  const raw = String(os || '').toLowerCase()
  if (raw === 'darwin' || raw === 'macos' || raw === 'mac') {
    return { glyph: iconSvg(OS_ICON_PATHS.darwin, { class: 'os-glyph' }), label: 'macOS' }
  }
  if (raw === 'win' || raw === 'win32' || raw === 'windows') {
    return { glyph: iconSvg(OS_ICON_PATHS.win, { class: 'os-glyph' }), label: 'Windows' }
  }
  if (raw === 'linux') {
    return { glyph: iconSvg(OS_ICON_PATHS.linux, { class: 'os-glyph' }), label: 'Linux' }
  }
  return { glyph: '', label: os ? esc(os) : '' }
}

/** `osGlyph()` rendered as one inline chip (icon + label), for table cells. */
export function osChip(os: string | null | undefined): string {
  const { glyph, label } = osGlyph(os)
  if (!label) return ''
  return `<span class="os-chip">${glyph}<span>${esc(label)}</span></span>`
}

const AVATAR_PALETTE = [
  '#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3', '#ede9fe', '#fee2e2', '#e0f2fe', '#f1f5f9'
]
const AVATAR_INK = '#0f172a'

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/** Initials tile with a deterministic color keyed off the identity string, plus an optional
 * green "live" dot. Never a photo Métis does not have. */
export function avatar(opts: { name: string; email?: string | null; live?: boolean }): string {
  const identity = opts.name || opts.email || '?'
  const bg = AVATAR_PALETTE[hashString(identity) % AVATAR_PALETTE.length]
  const initials = initialsOf(opts.name || opts.email || '?')
  const dot = opts.live ? '<i class="avatar-live" aria-hidden="true"></i>' : ''
  return `<span class="avatar" style="background:${bg};color:${AVATAR_INK}" title="${esc(identity)}">${esc(initials)}${dot}</span>`
}

export type IngestKind =
  | 'heartbeat' | 'ask' | 'recap' | 'listen' | 'rating' | 'crm' | 'vault' | 'license' | 'seat' | 'use' | 'platform'

const KIND_LABEL: Record<IngestKind, string> = {
  heartbeat: 'Heartbeat', ask: 'Ask', recap: 'Recap', listen: 'Listen', rating: 'Rating',
  crm: 'CRM', vault: 'Vault', license: 'License', seat: 'Seat', use: 'Use', platform: 'Platform'
}

/** Tint + icon + label for one ingest kind (Tony 9c2 tint map). Unknown kinds fall back to the
 * grey "seat" tint with their raw name, never a blank badge. */
export function kindBadge(kind: string): string {
  const known = Object.prototype.hasOwnProperty.call(KIND_ICON_PATHS, kind)
  const tintKey = known ? kind : 'seat'
  const label = known ? KIND_LABEL[kind as IngestKind] : kind
  const icon = iconSvg(KIND_ICON_PATHS[tintKey], { class: 'kind-icon' })
  return `<span class="kind-badge kind-${esc(tintKey)}">${icon}<span>${esc(label)}</span></span>`
}

/** Métis / Métis Light tier badge. Renders nothing for an unlicensed/unknown seat — never a
 * fabricated tier. */
export function tierBadge(tier: 'metis' | 'metis-light' | null | undefined): string {
  if (!tier) return ''
  const label = tier === 'metis-light' ? 'Métis Light' : 'Métis'
  return `<span class="tier-badge tier-${esc(tier)}">${esc(label)}</span>`
}

export type StatusDotState = 'live' | 'idle' | 'pending' | 'failed' | 'revoked'

/** Color dot plus text label — never color alone (a11y). */
export function statusDot(opts: { state: StatusDotState; label: string }): string {
  return `<span class="status-dot status-dot-${esc(opts.state)}"><i aria-hidden="true"></i><span>${esc(opts.label)}</span></span>`
}

/** "Métis 1.8.5" client-version chip. */
export function clientChip(version: string | null | undefined): string {
  if (!version) return ''
  return `<span class="client-chip">Métis ${esc(version)}</span>`
}

/** Up/down/flat percent delta chip (green/red/neutral), matching the reference's MetricTiles
 * delta chips. */
export function deltaChip(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return ''
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  const value = `${pct > 0 ? '+' : ''}${Math.round(pct * 10) / 10}%`
  return `<span class="delta-chip delta-${dir}">${arrow} ${esc(value)}</span>`
}

/** Wraps inline content with a `title` tooltip plus an `aria-describedby` span, so the hint
 * reaches both mouse and screen-reader users. */
export function tooltip(inner: string, text: string): string {
  const id = `tt-${hashString(text).toString(36)}`
  return `<span class="tooltip-host" title="${esc(text)}" aria-describedby="${id}">${inner}<span id="${id}" class="sr-only">${esc(text)}</span></span>`
}

/** N skeleton loading rows for a table body, shown while a client re-fetch is in flight. */
export function skeletonRows(n: number): string {
  const count = Math.max(0, Math.floor(n))
  return Array.from({ length: count }, () => '<div class="skeleton-row" aria-hidden="true"><i></i></div>').join('')
}

/** Empty state: title, description, and an optional mark (defaults to the reference's dashed
 * circle). Never fake rows to fill the space. */
export function emptyState(opts: { title: string; description?: string; mark?: string }): string {
  const mark = opts.mark ?? '<span class="empty-dash" aria-hidden="true"></span>'
  const desc = opts.description ? `<p>${esc(opts.description)}</p>` : ''
  return `<div class="empty-data" role="status">${mark}<strong>${esc(opts.title)}</strong>${desc}</div>`
}
