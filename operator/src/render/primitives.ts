/**
 * Small, atomic render primitives shared by every section page. Pure functions, no DOM,
 * `esc()` on every interpolated value. See operator/src/render/README.md (plan D2).
 *
 * No hard-coded hex anywhere in this file (plan P0.3): the one function that used to need a
 * per-identity colour (avatar()) computes an HSL hue and lets operator/src/spa/css.ts's
 * `--avatar-sat` / `--avatar-light` tokens (theme-aware) supply the rest.
 */
import { esc } from './index'
import { COUNTRY_NAMES } from './countries'
import { iconSvg, KIND_ICON_PATHS, NAV_ICON_PATHS, OS_ICON_PATHS } from './icons'

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

/**
 * @deprecated Plan 3.6 (rewritten 2026-09-06, Tony: "I want the country flags with their names
 * and more"): an emoji flag with no visible name next to it is retired in favour of
 * `countryCell(iso, opts)` below, everywhere except a header summary strip (`flagStrip()`).
 * Kept working, unchanged, for pages that still call it directly -- do not add new call sites.
 *
 * Emoji regional-indicator flag for an ISO 3166-1 alpha-2 code, with the country name in a
 * title (never color alone: `aria-label` carries the same name for screen readers). Unknown
 * codes render as plain text, never a fabricated flag.
 */
export function flag(iso: string | null | undefined): string {
  const code = String(iso || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ''
  const name = COUNTRY_NAMES[code] || code
  const glyph = String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)))
  return `<span class="flag" title="${esc(name)}" aria-label="${esc(name)}" role="img">${glyph}</span>`
}

/** First eight flags for a header summary strip (plan 3.6: "a flag never appears without its
 * name anywhere except a header summary strip, where the first eight countries show flag plus
 * name on hover") -- name-on-hover is `flag()`'s own `title`/`aria-label`, unchanged. Invalid or
 * duplicate codes are skipped rather than padded with a fabricated flag. */
export function flagStrip(isos: (string | null | undefined)[]): string {
  const rendered = isos
    .slice(0, 8)
    .map((iso) => flag(iso))
    .filter(Boolean)
    .join('')
  return rendered ? `<span class="flag-strip">${rendered}</span>` : ''
}

/** Numbers a countryCell() tooltip reports, each labeled with its source table (plan 3.7 item
 * 10). The caller computes every number; countryCell() only formats and labels them. */
export interface CountryCellStats {
  region?: string
  seats?: number
  live?: number
  asks?: number
  /** Pre-formatted ("3.2h") -- there is no shared duration formatter in this file yet. */
  timeSaved?: string
}

/**
 * Plan 3.6 (rewritten): a flag never appears without its name. 16x12 flag, the full country name
 * in 13px ink, and a secondary line in 11.5px --ink-3 -- the city or region the caller passes in
 * `secondary`, or the literal "Country only" when none was reported. An optional tooltip carries
 * the ISO code plus every number the caller supplies, each labeled with what it is. Region and
 * city cells follow the same rule (plan 3.6): pass the region/city name as `iso`'s country and
 * put the more specific name in a wrapping label the caller renders around this.
 */
export function countryCell(iso: string | null | undefined, opts?: { secondary?: string; stats?: CountryCellStats }): string {
  const code = String(iso || '').trim().toUpperCase()
  const valid = /^[A-Z]{2}$/.test(code)
  const name = valid ? COUNTRY_NAMES[code] || code : code || 'Unknown'
  const flagImg = valid
    ? `<img class="country-flag" src="/assets/flags/${code.toLowerCase()}.svg" width="16" height="12" alt="${esc(name)}">`
    : '<span class="country-flag country-flag-none" aria-hidden="true"></span>'
  const secondaryText = opts?.secondary || 'Country only'
  const inner = `<span class="country-cell">${flagImg}<span class="country-cell-body"><span class="country-cell-name">${esc(name)}</span><span class="country-cell-secondary">${esc(secondaryText)}</span></span></span>`
  const s = opts?.stats
  if (!s) return inner
  const parts = [`ISO ${valid ? code : 'unknown'}`]
  if (s.region) parts.push(s.region)
  if (s.seats != null) parts.push(`${s.seats} seat${s.seats === 1 ? '' : 's'}`)
  if (s.live != null) parts.push(`${s.live} live`)
  if (s.asks != null) parts.push(`${s.asks} ask${s.asks === 1 ? '' : 's'}`)
  if (s.timeSaved) parts.push(`${s.timeSaved} saved`)
  return tooltip(inner, parts.join(', '))
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

/** 12 hue buckets, 30deg apart -- enough spread to tell identities apart at a glance without an
 * inline style attribute (plan D6: CSP tightens to `style-src 'self'`, no `'unsafe-inline'`, so
 * a per-instance `style="--avatar-hue:N"` would be blocked at runtime). `data-hue` picks the
 * bucket; operator/src/spa/css.ts carries the twelve `[data-hue="N"]` rules that set
 * `--avatar-hue` from it. */
const AVATAR_HUE_BUCKETS = 12

/** Initials tile with a deterministic tint from the identity hash (plan 3.6: "8px radius
 * squircle feel"), plus an optional live dot bottom-right. Never a photo Métis does not have.
 * The tint is a bucketed `data-hue` attribute, never an inline style or a colour literal --
 * operator/src/spa/css.ts's `[data-hue="N"]` rules set `--avatar-hue`, and the `.avatar` rule
 * supplies the theme-aware saturation and lightness via `--avatar-sat` / `--avatar-light`. */
export function avatar(opts: { name: string; email?: string | null; live?: boolean }): string {
  const identity = opts.name || opts.email || '?'
  const hueBucket = hashString(identity) % AVATAR_HUE_BUCKETS
  const initials = initialsOf(opts.name || opts.email || '?')
  const dot = opts.live ? '<i class="avatar-live" aria-hidden="true"></i>' : ''
  return `<span class="avatar" data-hue="${hueBucket}" title="${esc(identity)}">${esc(initials)}${dot}</span>`
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

/** Métis / Métis Light tier badge. Renders nothing for an unlicensed/unknown seat, never a
 * fabricated tier. */
export function tierBadge(tier: 'metis' | 'metis-light' | null | undefined): string {
  if (!tier) return ''
  const label = tier === 'metis-light' ? 'Métis Light' : 'Métis'
  return `<span class="tier-badge tier-${esc(tier)}">${esc(label)}</span>`
}

export type StatusDotState = 'live' | 'idle' | 'pending' | 'failed' | 'revoked'

/** Color dot plus text label, never color alone (a11y). */
export function statusDot(opts: { state: StatusDotState; label: string }): string {
  return `<span class="status-dot status-dot-${esc(opts.state)}"><i aria-hidden="true"></i><span>${esc(opts.label)}</span></span>`
}

/** "Métis 1.8.5" client-version chip. */
export function clientChip(version: string | null | undefined): string {
  if (!version) return ''
  return `<span class="client-chip">Métis ${esc(version)}</span>`
}

/** Up/down/flat percent delta chip (green/red/neutral), matching the reference's MetricTiles
 * delta chips. `data-flash-key` (plan 3.5b) lets motion-bind.ts flash() this element when its
 * live-refresh value changes and it re-renders with the same key. */
export function deltaChip(pct: number | null | undefined, opts?: { flashKey?: string }): string {
  if (pct == null || !Number.isFinite(pct)) return ''
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  const value = `${pct > 0 ? '+' : ''}${Math.round(pct * 10) / 10}%`
  const flashAttr = opts?.flashKey ? ` data-flash-key="${esc(opts.flashKey)}" data-pop` : ''
  return `<span class="delta-chip delta-${dir}"${flashAttr}>${arrow} ${esc(value)}</span>`
}

/** Wraps inline content with a `title` tooltip plus an `aria-describedby` span, so the hint
 * reaches both mouse and screen-reader users. */
export function tooltip(inner: string, text: string): string {
  const id = `tt-${hashString(text).toString(36)}`
  return `<span class="tooltip-host" title="${esc(text)}" aria-describedby="${id}">${inner}<span id="${id}" class="sr-only">${esc(text)}</span></span>`
}

/** Plan 3.7 item 10: "every number has a source, hover any KPI for its formula and table."
 * `formula` is the human sentence, `source` is the concrete data source ("asks table, last 24h,
 * excluding usage-* seats"). Rendered as a small "?" affordance so it never crowds the numeral
 * itself; the full text reaches mouse and screen-reader users via tooltip(). */
export function sourceTooltip(formula: string, source: string): string {
  return tooltip('<span class="source-tooltip-mark" aria-hidden="true">?</span>', `${formula}. Source: ${source}`)
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

/** Connector logo, served from the Workers Static Assets binding (plan D5, 3.6): an `<img>`
 * pointing at `/assets/logos/<kind>.svg` (a real brand mark or the build script's generated
 * monogram, operator/scripts/build-assets.mjs, never chosen here). `alt` is always the label so
 * a slow/broken image still reads correctly. */
export function logoGlyph(kind: string, label: string, opts?: { size?: number }): string {
  const size = opts?.size ?? 28
  return `<img class="logo-glyph" src="/assets/logos/${esc(kind)}.svg" alt="${esc(label)}" width="${size}" height="${size}" loading="lazy">`
}

export type CatalogTileState = 'ready' | 'needs-oauth' | 'connected' | 'failing'

/** Plan 6.10c: "compact tiles ... 64px tall: 24px logo left, name 12.5px 600 on one line with
 * ellipsis and the full name in the title, an MCP or API micro badge, and a state dot only when
 * the kind is connected or inert. No description text, no per-tile buttons." A horizontal row
 * (logo, then a name+badge text column), never the taller stacked layout an earlier pass of this
 * primitive used. Ready tiles are clickable; `needs-oauth` tiles render identically but inert
 * (lock 12: "inert beats fake") with a lock glyph, never hidden and never a dead click; `connected`
 * tiles show a live dot carrying the connection count in its accessible name (never full label
 * text -- there is no room for one at this height). `failing` (plan 6.10b's emerald/rose/amber
 * status vocabulary, applied here too) is its own state, not a `connected` tile with a green dot
 * regardless of health: a kind whose only connection(s) are all currently failing gets the same
 * rose dot the row/Needs-attention status dots already use, not one indistinguishable from a
 * healthy connection. */
export function catalogTile(opts: {
  kind: string
  label: string
  transport: 'mcp' | 'rest'
  state: CatalogTileState
  connections?: number
  attrs?: string
}): string {
  const transportBadge = `<span class="chip catalog-tile-transport">${opts.transport === 'mcp' ? 'MCP' : 'API'}</span>`
  let meta = ''
  if (opts.state === 'failing') {
    const label = opts.connections ? `Needs attention, ${opts.connections} connection${opts.connections === 1 ? '' : 's'} failing` : 'Needs attention'
    meta = `<span class="catalog-tile-dot catalog-tile-dot-failing" role="img" aria-label="${esc(label)}" title="${esc(label)}"><i aria-hidden="true"></i><span class="sr-only">${esc(label)}</span></span>`
  } else if (opts.state === 'connected') {
    const label = opts.connections ? `Connected, ${opts.connections} connection${opts.connections === 1 ? '' : 's'}` : 'Connected'
    meta = `<span class="catalog-tile-dot catalog-tile-dot-connected" role="img" aria-label="${esc(label)}" title="${esc(label)}"><i aria-hidden="true"></i><span class="sr-only">${esc(label)}</span></span>`
  } else if (opts.state === 'needs-oauth') {
    meta = `<span class="catalog-tile-lock" role="img" aria-label="Needs OAuth (phase 2)" title="Needs OAuth (phase 2)">${iconSvg(KIND_ICON_PATHS.vault, { class: 'catalog-tile-lock-ic' })}<span class="sr-only">Needs OAuth (phase 2)</span></span>`
  }
  const inert = opts.state === 'needs-oauth' ? ' data-inert aria-disabled="true"' : ''
  return `<button type="button" class="catalog-tile catalog-tile-${esc(opts.state)}" data-catalog-tile="${esc(opts.kind)}"${inert} ${opts.attrs || ''}>
    ${logoGlyph(opts.kind, opts.label, { size: 24 })}
    <span class="catalog-tile-body">
      <span class="catalog-tile-name" title="${esc(opts.label)}">${esc(opts.label)}</span>
      <span class="catalog-tile-meta">${transportBadge}${meta}</span>
    </span>
  </button>`
}

/** Plan 6.1 / 3.7 item 7: the "⌘K" command palette shell, list markup, and search dropdown
 * pattern reuse this generic tab strip for anywhere a small set of named views needs one. */
export function tabs(opts: { items: { id: string; label: string; active?: boolean }[]; attrs?: string }): string {
  return `<div class="tabs" role="tablist" ${opts.attrs || ''}>${opts.items
    .map(
      (t) =>
        `<button type="button" class="tab${t.active ? ' on' : ''}" role="tab" aria-selected="${t.active ? 'true' : 'false'}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`
    )
    .join('')}</div>`
}

export type ChipTone = 'default' | 'ok' | 'warn' | 'danger' | 'accent'

/** Generic pill chip. `tone` maps to the same status colours as statusDot()/deltaChip() so a
 * page never invents its own colour meaning. `attrs` is optional extra markup (a `data-*` hook
 * for a caller that needs to find and update this exact chip later, e.g. once a name it could not
 * resolve at render time loads client-side) -- never a place for a colour or layout override. */
export function chip(opts: { label: string; tone?: ChipTone; icon?: string; attrs?: string }): string {
  const tone = opts.tone && opts.tone !== 'default' ? ` chip-${opts.tone}` : ''
  const attrs = opts.attrs ? ` ${opts.attrs}` : ''
  return `<span class="chip${tone}"${attrs}>${opts.icon || ''}${esc(opts.label)}</span>`
}

/** Segmented control (reference: theme System/Light/Dark). A generic version of the same
 * `.theme-group`/`.theme-btn` pattern for anywhere else a small exclusive choice is shown as
 * a row of pill buttons (plan 6.11 Appearance: density, reduced motion). */
export function segmented(opts: { items: { id: string; label: string; active?: boolean }[]; attrs?: string }): string {
  return `<div class="segmented" role="radiogroup" ${opts.attrs || ''}>${opts.items
    .map(
      (i) =>
        `<button type="button" class="segmented-item${i.active ? ' on' : ''}" role="radio" aria-checked="${i.active ? 'true' : 'false'}" data-segmented="${esc(i.id)}">${esc(i.label)}</button>`
    )
    .join('')}</div>`
}

export type ToastKind = 'info' | 'success' | 'error'

/** Plan 6.1: bottom-right toast, one at a time, request id on errors, Undo where the action
 * supports it. Markup only, operator/client owns the show/auto-dismiss timer. */
export function toast(opts: { message: string; kind?: ToastKind; requestId?: string; undo?: boolean }): string {
  const kind = opts.kind ?? 'info'
  const requestId = opts.requestId ? `<span class="toast-request-id">${esc(opts.requestId)}</span>` : ''
  const undo = opts.undo ? '<button type="button" class="btn toast-undo" data-toast-undo>Undo</button>' : ''
  return `<div class="toast toast-${esc(kind)}" role="status" data-toast>
    <span class="toast-message">${esc(opts.message)}</span>
    ${requestId}
    ${undo}
    <button type="button" class="toast-dismiss" data-toast-dismiss aria-label="Dismiss">${iconSvg(NAV_ICON_PATHS.x, { class: 'tool-ic' })}</button>
  </div>`
}

/** Plan 9, "no window.prompt": a small modal dialog with a labeled (optionally masked) input,
 * Cancel and a named confirm action. operator/client owns focus trap, Escape-to-cancel and the
 * reveal toggle; this is markup only, hidden by default. */
export function dialog(opts: {
  id: string
  title: string
  label: string
  placeholder?: string
  confirmLabel?: string
  masked?: boolean
}): string {
  const inputType = opts.masked ? 'password' : 'text'
  const reveal = opts.masked
    ? `<button type="button" class="tool dialog-reveal" data-dialog-reveal aria-pressed="false">Show</button>`
    : ''
  return `<div id="${esc(opts.id)}" class="dialog-overlay" hidden data-dialog>
    <div class="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="${esc(opts.id)}-title">
      <h4 id="${esc(opts.id)}-title">${esc(opts.title)}</h4>
      <label class="dialog-label" for="${esc(opts.id)}-input">${esc(opts.label)}</label>
      <div class="dialog-input-wrap">
        <input id="${esc(opts.id)}-input" type="${inputType}" class="dialog-input" placeholder="${esc(opts.placeholder || '')}" autocomplete="off">
        ${reveal}
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn" data-dialog-cancel>Cancel</button>
        <button type="button" class="btn primary" data-dialog-confirm>${esc(opts.confirmLabel || 'Confirm')}</button>
      </div>
    </div>
  </div>`
}

/** Plan Settings › Audit log: a CSV export affordance next to a table. Markup only; the href
 * is the real export route (never a client-only download of what is on screen). */
export function exportMenu(opts: { csvHref: string; label?: string }): string {
  return `<a class="tool export-menu" href="${esc(opts.csvHref)}" data-export-link>${iconSvg(NAV_ICON_PATHS['chevrons-up-down'], { class: 'tool-ic' })}<span>${esc(opts.label || 'Export CSV')}</span></a>`
}

export type AlertBadgeVariant = 'ok' | 'danger' | 'info' | 'warn'

/**
 * Plan 3.5c (ported from a Tremor-style alert badge): a pill in --ok/--danger/--info with white
 * ink, an optional 16px icon (an SVG path from icons.ts) separated by a 1px divider in the same
 * hue lightened, and an optional action link. Used for the platform state strip on Settings ›
 * Platform health, "Major incident" notices on Notifications, and the connector health chip.
 */
export function alertBadge(opts: {
  variant: AlertBadgeVariant
  icon?: string
  label: string
  action?: { label: string; href?: string; attrs?: string }
}): string {
  const iconHtml = opts.icon
    ? `${iconSvg(opts.icon, { class: 'alert-badge-icon' })}<span class="alert-badge-divider" aria-hidden="true"></span>`
    : ''
  const actionHtml = opts.action
    ? `<a class="alert-badge-action" href="${esc(opts.action.href || '#')}" ${opts.action.attrs || ''}>${esc(opts.action.label)}</a>`
    : ''
  return `<span class="alert-badge alert-badge-${esc(opts.variant)}">${iconHtml}<span class="alert-badge-label">${esc(opts.label)}</span>${actionHtml}</span>`
}
