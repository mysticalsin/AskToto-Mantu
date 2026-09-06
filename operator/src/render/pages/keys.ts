/**
 * Keys page (plan 6.9, P1.7 brief). The Vault: provider API keys the Operator holds and spends on
 * behalf of licensed seats through `/v1/use` (operator/src/use.ts) after license validation.
 * Seats never see or hold these secrets, only last4 ever reaches HTML or JSON.
 *
 * Data notes (payload gaps, documented rather than hidden, plan lock 3 "no fake data"):
 *  - `VaultKeyMeta` (operator/src/store.ts, a file this page does not own) carries id, provider,
 *    label, last4, status, createdAt, rotatedAt, revokedAt. It carries no per-key "last used"
 *    timestamp or "uses" counter -- there is no column for either in `vault_keys` (schema.sql) and
 *    no `/v1/use` call is attributed to a specific vault row (operator/src/use.ts's
 *    `decryptActiveLlmSecret` looks up "the active row for this provider", not a row id). This page
 *    therefore renders the four usage columns the brief specifies (asks 7d, tokens 7d, cost
 *    estimate, last seat) from data that IS in the payload -- `data.gateway.rows` (provider-level,
 *    already computed by dashboard.ts from the real 7-day `asks` window) for the first three, and
 *    the most recent matching `kind: 'use'` entry in `data.events` (device_id + `detail: "use
 *    <provider>"`, written by handleUse()) for the last one -- and never invents "last used" /
 *    "uses" columns the schema cannot back. See this task's final report for the exact backend
 *    patch that would add true per-key attribution.
 *  - `data.events` is the fleet's most recent 80 events across every kind (dashboard.ts
 *    `mergeEvents`), not a per-provider log, so "last seat" can under-report on a very busy fleet
 *    (a real, more recent use could have scrolled out of that window). The column's source tooltip
 *    says so; a provider with no match in that window reads "not reported", never a stale guess.
 *  - The Cloudflare AI Gateway card's connect-based credential (`provider: 'cloudflare-account'`,
 *    operator/src/vault.ts's `CF_ACCOUNT_PROVIDER`) is never an LLM spending key ("No paste": it is
 *    only ever written by the OAuth callback, operator/src/cloudflare-connect.ts) and is excluded
 *    from the Vault table below -- it has no asks, no tokens, no last4 a Rotate/Revoke pair would
 *    make sense against. Its own card handles connect/re-connect.
 */
import type { DashboardPayload } from '../../dashboard'
import type { VaultKeyMeta } from '../../store'
import { CF_OAUTH_MISSING } from '../../cloudflare-connect'
import { CF_TOKEN_MISSING, type CloudflareOverview } from '../../cloudflare'
import { CF_ACCOUNT_PROVIDER, VAULT_LLM_PROVIDERS, fundedProvidersFromMeta } from '../../vault'
import {
  avatar,
  chip,
  dataTable,
  dialog,
  esc,
  logoGlyph,
  pageHeader,
  sourceTooltip,
  statusDot,
  timeCell,
  type DataTableColumn,
  type DataTableRow,
  type RenderCtx,
  type StatusDotState
} from '../index'
// Desktop/Operator share one provider catalog for "what does this key look like, where do I get
// one" (repo-root src/shared/providers.ts): the signup page and key shape for, say, Anthropic is
// identical whether it is pasted into the desktop Settings screen or the Operator vault. Read-only
// reuse, the same cross-boundary import operator/src/use.ts already makes.
import { PROVIDERS, type ProviderId } from '../../../../src/shared/providers'

// ---------------------------------------------------------------------------
// Small local helpers.
// ---------------------------------------------------------------------------

function providerLabel(id: string): string {
  const known = Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : null
  return known ? known.label : id
}

/** Plan 3.6 / this task's brief: reuse `logoGlyph()` where a real brand mark ships under
 *  operator/public/logos, else a monogram chip -- never a broken `<img>`. None of the vault LLM
 *  provider ids have a shipped SVG today (that directory holds only connector-catalog kinds:
 *  hubspot, notion, slack...); extend this set (and it starts rendering through `logoGlyph()`
 *  below) the day operator/scripts/build-assets.mjs ships a real mark for one of these ids -- a
 *  file this page does not own, see this task's final report. */
const LOGO_SLUGS = new Set<string>()

/** The recognizable half of a "Product · Vendor" label ("Claude · Anthropic" -> "Claude"), for a
 *  clean one/two-letter monogram. Every PROVIDERS label puts the distinctive name first; splitting
 *  on the raw label would hand `avatar()`'s initialsOf() the middle dot itself as a second "word"
 *  (its splitter treats the whitespace around "·" as a boundary, not the glyph), producing "C·"
 *  instead of "CL". Falls through unchanged for the few single-word labels (DeepSeek, Groq...). */
function monogramName(label: string): string {
  const dot = label.indexOf('·')
  return (dot >= 0 ? label.slice(0, dot) : label).trim()
}

/** `avatar()` (design-lead's primitive) already renders exactly the "first letter(s), rounded
 *  square, deterministic tint" shape plan 3.6 describes for a generated monogram, so it is reused
 *  here rather than duplicating that shape as new markup. Wrapped in a `data-pop` span for the
 *  "provider logo glyphs fade in" motion line (plan 3.5b Keys row) -- `pop()` (operator/client/
 *  motion.ts) is the closest vocabulary entry to a fade-scale entrance and is already wired
 *  generically by bindMotion(), so no new JS is needed here. */
function providerGlyph(provider: string, label: string): string {
  const glyph = LOGO_SLUGS.has(provider) ? logoGlyph(provider, label) : avatar({ name: monogramName(label) })
  return `<span class="keys-provider-glyph" data-pop>${glyph}</span>`
}

function statusChip(state: StatusDotState, label: string): string {
  return statusDot({ state, label })
}

function vaultStatusChip(status: string): string {
  if (status === 'active') return statusChip('live', 'Active')
  if (status === 'revoked') return statusChip('revoked', 'Revoked')
  if (status === 'superseded') return statusChip('idle', 'Superseded')
  return statusChip('idle', status)
}

/** A provider label the way it reads inside a sentence ("Revoke the Anthropic key?"), even for an
 *  id PROVIDERS does not carry (a future vault id, or a corrupted row `sanitizeVaultMeta()` had to
 *  fall back to `'provider'` for). */
function sentenceProviderLabel(provider: string): string {
  const label = providerLabel(provider)
  return label === provider ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

// ---------------------------------------------------------------------------
// Usage columns (asks 7d, tokens 7d, cost estimate, last seat) -- plan 3.5b "usage bars (asks,
// tokens, cost) grow on load". A continuous, unbucketed percentage bar with zero inline `style=`
// (gates.mjs gate 2), the same `<svg width="N%">` technique operator/src/render/pages/_shared.ts's
// percentBar() uses (that helper lives in a file this task does not own; the shape is small enough
// to keep local rather than adding a shared export mid-wave). `data-grow` (operator/client/
// motion-bind.ts) animates it from zero width on every bind, matching the "grow on load" line.
// ---------------------------------------------------------------------------

function usageBar(pct: number, delayMs: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct * 100) / 100))
  return `<svg class="keys-usage-bar" width="${clamped}%" height="100%" data-grow data-grow-delay="${delayMs}" aria-hidden="true"></svg>`
}

/** One usage cell: the formatted value with its source tooltip, plus a proportional bar sized
 *  against the largest value this column shows across the rows actually rendered (never against a
 *  fixed, invented ceiling). `raw` null (no data for this provider in the 7 day window) renders the
 *  honest "not reported" text and no bar at all -- a zero-width bar would look like "confirmed
 *  zero", not "unknown" (plan lock 3). */
function usageCell(opts: {
  raw: number | null
  display: string
  max: number
  index: number
  formula: string
  source: string
}): string {
  const tip = sourceTooltip(opts.formula, opts.source)
  if (opts.raw == null || opts.max <= 0) {
    return `<span class="muted">not reported</span>${tip}`
  }
  const pct = Math.max(6, Math.round((opts.raw / opts.max) * 100))
  return `<div class="keys-usage-cell"><span class="keys-usage-value">${esc(opts.display)}</span>${tip}${usageBar(pct, opts.index * 40)}</div>`
}

/** Cost estimate strings already come pre-formatted ("$0.42") from dashboard.ts's
 *  `formatUsdEstimate`; the bar still needs a plain number to size against, parsed back out rather
 *  than re-deriving the estimate here (this page does not own the pricing table). */
function parseUsd(estimate: string | null): number | null {
  if (!estimate) return null
  const n = Number(estimate.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Last seat (plan brief: "last seat", sourced from the asks/events data available in the payload).
// data.gateway.rows carries no seat attribution, so this reads the most recent `kind: 'use'` event
// (operator/src/use.ts's handleUse() inserts one per Operator-brokered call, `detail: "use
// <provider>"`) for the provider, out of the fleet's most recent 80 events overall
// (operator/src/dashboard.ts `mergeEvents`). Real data, honestly windowed -- see this file's top
// comment.
// ---------------------------------------------------------------------------

function lastSeatFor(events: DashboardPayload['events'], provider: string): { text: string; ts: number | null } {
  const marker = `use ${provider}`
  for (const e of events) {
    if (e.name !== 'use') continue
    if (!e.chips.some((c) => c.value === marker)) continue
    const who = e.hostname || e.email
    return { text: who || 'Unnamed seat', ts: e.ts }
  }
  return { text: 'not reported', ts: null }
}

// ---------------------------------------------------------------------------
// Vault table.
// ---------------------------------------------------------------------------

const VAULT_COLUMNS: DataTableColumn[] = [
  { key: 'provider', label: 'Provider' },
  { key: 'label', label: 'Label' },
  { key: 'last4', label: 'Last4' },
  { key: 'status', label: 'Status' },
  { key: 'created', label: 'Created' },
  { key: 'rotated', label: 'Rotated' },
  { key: 'asks', label: 'Asks 7d' },
  { key: 'tokens', label: 'Tokens 7d' },
  { key: 'cost', label: 'Cost estimate' },
  { key: 'lastSeat', label: 'Last seat' },
  { key: 'actions', label: '' }
]

type UsageByProvider = Map<string, { asks: number; tokens: number | null; estimate: string | null }>

function usageByProvider(gateway: DashboardPayload['gateway']): UsageByProvider {
  const by: UsageByProvider = new Map()
  for (const row of gateway.rows) by.set(row.provider, { asks: row.asks, tokens: row.tokens, estimate: row.estimate })
  return by
}

function vaultRowCells(
  v: VaultKeyMeta,
  now: number,
  usage: UsageByProvider,
  maxAsks: number,
  maxTokens: number,
  maxCost: number,
  events: DashboardPayload['events'],
  rowIndex: number
): Record<string, string> {
  const u = usage.get(v.provider)
  const label = providerLabel(v.provider)
  const isCurrent = v.status === 'active'
  const seat = isCurrent ? lastSeatFor(events, v.provider) : { text: 'not applicable', ts: null }
  const actions =
    v.status === 'active'
      ? `<div class="row keys-row-actions">
          <button type="button" class="tool" data-rotate="${esc(v.id)}">Rotate</button>
          <button type="button" class="tool danger" data-revoke="${esc(v.id)}" data-revoke-provider="${esc(sentenceProviderLabel(v.provider))}">Revoke</button>
        </div>`
      : ''
  return {
    provider: `<div class="keys-provider-cell">${providerGlyph(v.provider, label)}<span>${esc(label)}</span></div>`,
    label: esc(v.label),
    last4: `<span class="mono">••${esc(v.last4)}</span>`,
    status: vaultStatusChip(v.status),
    created: timeCell(v.createdAt, now),
    rotated: v.rotatedAt ? timeCell(v.rotatedAt, now) : '<span class="muted">Never rotated</span>',
    asks: isCurrent
      ? usageCell({
          raw: u?.asks ?? null,
          display: u ? String(u.asks) : '0',
          max: maxAsks,
          index: rowIndex,
          formula: 'Asks reported for this provider in the last 7 days',
          source: 'asks table, last 7 days, grouped by provider'
        })
      : '<span class="muted">not applicable</span>',
    tokens: isCurrent
      ? usageCell({
          raw: u?.tokens ?? null,
          display: u?.tokens != null ? String(u.tokens) : '0',
          max: maxTokens,
          index: rowIndex,
          formula: 'Input, output and cache tokens for this provider in the last 7 days',
          source: 'asks table, last 7 days, grouped by provider'
        })
      : '<span class="muted">not applicable</span>',
    cost: isCurrent
      ? usageCell({
          raw: u ? parseUsd(u.estimate) : null,
          display: u?.estimate ?? '$0',
          max: maxCost,
          index: rowIndex,
          formula: 'List-price estimate from tokens and cache reads for this provider, last 7 days',
          source: 'asks table, last 7 days, provider list price'
        })
      : '<span class="muted">not applicable</span>',
    lastSeat: isCurrent
      ? `<span>${esc(seat.text)}${seat.ts != null ? ` · ${timeCell(seat.ts, now)}` : ''}</span>${sourceTooltip(
          'The seat that most recently called this provider through the Operator',
          'live events feed, most recent 80 events fleet-wide; may miss an older call on a busy fleet'
        )}`
      : '<span class="muted">not applicable</span>',
    actions
  }
}

function vaultRowAttrs(v: VaultKeyMeta, isTopVisible: boolean): string {
  const flash = isTopVisible ? ' data-flash-key="keys-vault-top"' : ''
  const history = v.status === 'active' ? '' : ' hidden data-key-history-row'
  return `data-key="${esc(v.id)}" data-key-provider="${esc(v.provider)}"${flash}${history}`
}

export interface VaultTableResult {
  html: string
  historyCount: number
}

/** Exported so this module's tests can exercise the table in isolation from the full page shell,
 *  the same pattern operator/src/render/pages/groups.ts's renderGroupsTable() establishes, and so
 *  operator/client/pages/keys.ts's patchVaultTable() can re-render just this table client-side
 *  after an Add/Rotate/Revoke and FLIP it into place instead of asking for a whole-section
 *  rerender() (plan 3.5b: "the new row inserts with FLIP and an accent wash" -- see this task's
 *  final report for the small operator/client/actions.ts patch that calls patchVaultTable(),
 *  a file this page does not own). Active rows sort newest-first (createdAt desc) so a freshly
 *  added or rotated key lands at row 0, the slot renderVaultTable() marks with
 *  `data-flash-key="keys-vault-top"` -- the accent-wash half of that same motion line. History
 *  rows (superseded, revoked) sort by their most recent status change and start `hidden`,
 *  revealed by the "Show history" toggle operator/client/pages/keys.ts wires. */
export function renderVaultTable(data: DashboardPayload, now: number): VaultTableResult {
  const vault = data.keys.vault.filter((v) => v.provider !== CF_ACCOUNT_PROVIDER)
  const active = vault.filter((v) => v.status === 'active').sort((a, b) => b.createdAt - a.createdAt)
  const history = vault
    .filter((v) => v.status !== 'active')
    .sort((a, b) => (b.revokedAt ?? b.rotatedAt ?? b.createdAt) - (a.revokedAt ?? a.rotatedAt ?? a.createdAt))

  const usage = usageByProvider(data.gateway)
  const activeUsage = active.map((v) => usage.get(v.provider))
  const maxAsks = Math.max(0, ...activeUsage.map((u) => u?.asks ?? 0))
  const maxTokens = Math.max(0, ...activeUsage.map((u) => u?.tokens ?? 0))
  const maxCost = Math.max(0, ...activeUsage.map((u) => parseUsd(u?.estimate ?? null) ?? 0))

  const ordered = [...active, ...history]
  const rows: DataTableRow[] = ordered.map((v, i) => ({
    cells: vaultRowCells(v, now, usage, maxAsks, maxTokens, maxCost, data.events, i),
    attrs: vaultRowAttrs(v, i === 0 && active.length > 0)
  }))

  const html = dataTable({
    columns: VAULT_COLUMNS,
    rows,
    emptyTitle: 'No provider keys yet.',
    emptyDescription: 'Add a key below so licensed seats can ask through the Operator.',
    id: 'vault-table',
    rowClass: 'vault-row'
  })
  return { html, historyCount: history.length }
}

/** Exported so operator/client/pages/keys.ts's patchVaultTable() can re-sync this button's label
 *  after a scoped table patch (a Rotate/Revoke can move `count` from 0 to 1, which needs this
 *  markup to newly appear) without asking for a whole-section rerender. */
export function renderHistoryToggle(count: number): string {
  if (count <= 0) return ''
  return `<button type="button" class="tool keys-history-toggle" data-keys-history-toggle aria-expanded="false" data-show-label="Show history (${count})" data-hide-label="Hide history">Show history (${count})</button>`
}

// ---------------------------------------------------------------------------
// Add key card.
// ---------------------------------------------------------------------------

/** One `<option>` plus, for the "Hosted LLM providers" group, a hidden help paragraph the client
 *  toggles on `change` (plan brief: "one line of help per provider" -- what the key looks like,
 *  where to create it). Reuses the desktop's own provider catalog (`keyHint`, `keyUrl`) so the
 *  copy never drifts from what Settings already tells a person pasting the same key elsewhere. */
function llmProviderOption(id: ProviderId): string {
  return `<option value="${esc(id)}">${esc(PROVIDERS[id].label)}</option>`
}

function llmProviderHelp(id: ProviderId): string {
  const def = PROVIDERS[id]
  let host = def.keyUrl
  try {
    host = def.keyUrl ? new URL(def.keyUrl).host : ''
  } catch {
    host = ''
  }
  const link = def.keyUrl ? ` <a href="${esc(def.keyUrl)}" target="_blank" rel="noopener noreferrer">Get one at ${esc(host)}.</a>` : ''
  return `<p class="keys-provider-help" data-provider-help="${esc(id)}" hidden>Looks like ${esc(def.keyHint)}.${link}</p>`
}

/** The Hosted LLM ids from operator/src/vault.ts's allow-list, minus the two that get their own
 *  select group below (cloudflare has a separate credential shape, custom needs no external
 *  signup page to link to). */
const HOSTED_LLM_IDS = VAULT_LLM_PROVIDERS.filter(
  (id): id is Exclude<(typeof VAULT_LLM_PROVIDERS)[number], 'cloudflare' | 'custom'> => id !== 'cloudflare' && id !== 'custom'
)

function renderAddKeyForm(vaultBound: boolean): string {
  const options = HOSTED_LLM_IDS.map((id) => llmProviderOption(id as ProviderId)).join('')
  const help = HOSTED_LLM_IDS.map((id) => llmProviderHelp(id as ProviderId)).join('')
  const disabledNote = vaultBound
    ? ''
    : `<div class="fail-loud" data-vault-unbound>Vault key is not bound on this Worker. Add and Rotate will fail until OPERATOR_VAULT_KEY is set.</div>`
  return `${disabledNote}
    <form class="key-form keys-add-form" id="key-add" autocomplete="off">
      <label>Provider
        <select name="provider" id="keys-add-provider" required>
          <optgroup label="Hosted LLM providers">${options}</optgroup>
          <optgroup label="Cloudflare">
            <option value="cloudflare" disabled>Cloudflare · AI Gateway</option>
          </optgroup>
          <optgroup label="Custom">
            <option value="custom">Custom · OpenAI-compatible</option>
          </optgroup>
        </select>
      </label>
      ${help}
      <p class="keys-provider-help" data-provider-help="cloudflare" hidden>Cloudflare connects by logging in below, not by pasting a key here.</p>
      <p class="keys-provider-help" data-provider-help="custom" hidden>Point at your own OpenAI-compatible endpoint. Stored in the vault; not yet reachable through /v1/use.</p>
      <label>Label
        <input name="label" type="text" placeholder="Anthropic production" maxlength="80">
      </label>
      <label>API key
        <span class="keys-secret-wrap">
          <input name="secret" id="keys-add-secret" type="password" class="keys-secret-input" placeholder="Paste the key" required autocomplete="off">
          <button type="button" class="tool" id="keys-add-reveal" data-keys-reveal aria-pressed="false">Show</button>
        </span>
      </label>
      <button class="primary" type="submit">Add</button>
    </form>
    <div id="key-msg" class="muted pad-8-0"></div>`
}

// ---------------------------------------------------------------------------
// Funded providers.
// ---------------------------------------------------------------------------

function renderFundedProviders(vault: VaultKeyMeta[]): string {
  const funded = fundedProvidersFromMeta(vault)
  if (!funded.length) {
    return `<div class="muted">No provider is funded yet. Add a key above so the fleet can ask through the Operator.</div>`
  }
  const chips = funded
    .map((id) => `<span data-stagger>${chip({ label: providerLabel(id), tone: 'ok' })}</span>`)
    .join('')
  return `<div class="keys-funded-chips">${chips}</div>`
}

// ---------------------------------------------------------------------------
// Cloudflare AI Gateway card.
// ---------------------------------------------------------------------------

function cfTile(label: string, value: number | null, rawKey: string, formula: string): string {
  const display = value == null ? 'not reported' : value.toLocaleString('en-US')
  const countAttr = value != null ? ` data-count-to="${value}"` : ''
  return `<div class="card kpi keys-cf-tile">
    <div class="kpi-top"><h3>${esc(label)}</h3>${sourceTooltip(formula, 'Cloudflare account API, last 24h')}</div>
    <div class="n"${countAttr} data-flash-key="cf-${esc(rawKey)}">${esc(display)}</div>
  </div>`
}

/** The connect control is a real, working `<a href="/cloudflare/connect">` whenever this Worker
 *  can actually start the OAuth handshake, and an inert `<button disabled>` with the reason in its
 *  `title` when it cannot (plan 6.9: "connect button disabled with the reason when OAuth secrets
 *  are missing"; lock 12, "inert beats fake" -- never a dead link that 404s the handshake). This is
 *  independent of whether Cloudflare is already connected: the status text below always reflects
 *  the real `cf` state (idle, rejected, or connected) regardless of `oauthBound`, since a
 *  `cloudflare-account` credential can already exist (added directly through `POST
 *  /v1/admin/keys`, operator/src/cloudflare.test.ts's own fixtures do exactly this) even on a
 *  Worker whose OAuth client secrets are not yet bound -- oauthBound only gates *starting a new*
 *  login, never hides a credential's real, already-known status. */
function cfConnectControl(oauthBound: boolean, connected: boolean): string {
  const label = connected ? 'Reconnect Cloudflare' : 'Log in to Cloudflare'
  const primary = connected ? '' : ' primary'
  if (oauthBound) {
    return `<a class="btn${primary}" id="cf-connect" data-cf-aig-connect href="/cloudflare/connect">${esc(label)}</a>`
  }
  return `<button type="button" class="btn${primary}" id="cf-connect" disabled aria-disabled="true" title="${esc(CF_OAUTH_MISSING)}">${esc(label)}</button>`
}

function renderCloudflareCard(oauthBound: boolean, cf: CloudflareOverview): string {
  const oauthNotice = oauthBound ? '' : `<div class="fail-loud" data-cf-oauth-missing>${esc(CF_OAUTH_MISSING)}</div>`
  let status: string
  // `connected` (operator/src/cloudflare.ts) means "a credential was on file and the Worker tried
  // it", true even when that attempt failed (pullCloudflareOverview() sets `connected: true,
  // error: CF_TOKEN_REJECTED` on a 401/403 -- operator/src/cloudflare.test.ts's "fails loud on a
  // rejected Cloudflare token" fixture is exactly this shape). Only a real, error-free attempt
  // earns the tiles; a rejected or otherwise-failed one still says so loudly.
  if (cf.connected && !cf.error) {
    const workers = cf.workers.length ? cf.workers.map((w) => esc(w)).join(', ') : 'none listed'
    status = `<div class="keys-cf-tiles">
        ${cfTile('Requests', cf.requests, 'requests', 'Worker invocations, last 24 hours')}
        ${cfTile('Errors', cf.errors, 'errors', 'Worker invocations that returned an error, last 24 hours')}
        ${cfTile('CPU', cf.cpuMs, 'cpu', 'Total Worker CPU time in milliseconds, last 24 hours')}
      </div>
      <p class="sub muted pad-b8">Workers: ${workers}. D1 ${esc(cf.d1Name || 'metis-operator')} ${esc(cf.d1Id || '')}.</p>`
  } else if (cf.error && cf.error !== CF_TOKEN_MISSING) {
    status = `<div class="fail-loud" data-cf-error>${esc(cf.error)}</div>`
  } else {
    status = `<p class="sub muted" data-cf-idle>${esc(cf.error || CF_TOKEN_MISSING)}</p>`
  }
  return `${oauthNotice}
    ${status}
    <p>${cfConnectControl(oauthBound, cf.connected)}</p>
    <p id="cf-connect-msg" class="muted pad-8-0"></p>`
}

// ---------------------------------------------------------------------------
// Page shell.
// ---------------------------------------------------------------------------

export function renderKeys(data: DashboardPayload, _ctx: RenderCtx): string {
  const now = _ctx.now
  const { html: vaultTable, historyCount } = renderVaultTable(data, now)
  return `${pageHeader({ title: 'Keys', subtitle: 'Provider keys the Operator spends on behalf of licensed seats.' })}
    <p class="keys-explainer">Seats never receive these keys. A licensed seat calls the Operator, and the Operator calls the provider.</p>
    <div class="keys-grid">
      <article class="card pad-b10 keys-col-6" data-keys-vault-card>
        <div class="keys-card-head">
          <p class="card-label card-label-flush">Vault</p>
          ${renderHistoryToggle(historyCount)}
        </div>
        ${vaultTable}
      </article>
      <article class="card pad-b10 keys-col-3" data-keys-add-card>
        <p class="card-label">Add key</p>
        ${renderAddKeyForm(data.keys.vaultBound)}
      </article>
      <article class="card pad-b10 keys-col-3" data-keys-funded-card>
        <p class="card-label">Funded providers</p>
        <p class="sub muted pad-b8">What the fleet can use right now.</p>
        ${renderFundedProviders(data.keys.vault)}
      </article>
      <article class="card pad-b10 keys-col-6" data-cf-overview>
        <p class="card-label">Cloudflare · AI Gateway</p>
        <p class="sub muted pad-b8">What the ${esc(data.cloudflare.worker)} Worker reports about itself through Cloudflare's own account API.</p>
        ${renderCloudflareCard(data.keys.oauthBound, data.cloudflare)}
      </article>
    </div>
    ${dialog({ id: 'rotate-key-dialog', title: 'Rotate key', label: 'New secret or token', confirmLabel: 'Rotate', masked: true })}`
}
