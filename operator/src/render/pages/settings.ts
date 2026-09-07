/**
 * Settings page (plan 6.11, task P1.10, backend B5/B6). Tabs: Tiers, Value, Skills, Questions,
 * Platform health, Session, Appearance. Audit log is its own page (plan 6.11b, `audit.ts`, a file
 * this page does not own).
 *
 * Server/client split (plan D2), same shape operator/src/render/pages/connectors.ts already
 * establishes for a page whose full data is not part of `DashboardPayload`: `renderSettings(data,
 * ctx)` renders every tab from real fields already on `DashboardPayload` (email, `roi` for Value,
 * `ops.timeSaved` for the Value preview basis, `keys.*Bound` for Platform health's binding rows,
 * `proposals` for the Skills board) plus code constants (the entitlement catalog, the default
 * tier entitlements, the time-saved assumptions) -- never a fetch on first paint, so the page
 * still renders with no JS. Five regions need data no `DashboardPayload` field carries (real seat
 * counts per tier, the stored `dailyTokenBudgetPerSeat`/density/reducedMotion, push history and
 * computed evidence for Skills, the full Questions analytics, and live Platform health): each
 * renders a named loading state here and is patched in place by
 * operator/client/pages/settings.ts's fetches to `GET /v1/admin/tiers`, `GET
 * /v1/admin/settings.json`, `GET /v1/admin/skills.json`, `GET /v1/admin/questions.json` (task B5,
 * operator/src/routes/insights.ts) and `GET /health` + `GET /v1/admin/health.json`, through the
 * exact same pure render functions this module exports (and this module's test exercises), so
 * server and client markup never drift.
 *
 * Locks: no fake data (every loading region says so, never a stand-in number); no em dash; no
 * inline `style=`; sentence case; every number with a `sourceTooltip()`.
 */
import type { DashboardPayload } from '../../dashboard'
import { DEFAULT_TIER_ENTITLEMENTS, defaultTiers } from '../../store'
import {
  OPERATOR_ENTITLEMENT_KEYS,
  type OperatorEntitlementKey
} from '../../../../src/shared/operator-entitlements'
import { DEFAULT_TIME_SAVED_ASSUMPTIONS } from '../../../../src/shared/time-saved'
import { QUESTION_TYPE_LABELS } from '../../../../src/shared/question-type'
import { ADMIN_EMAILS, SESSION_REMINT_AFTER_MS } from '../../access'
import { RETENTION_MS } from '../../retention'
import { EXPORT_TABLES } from '../../export/tables'
import {
  chip,
  dataTable,
  emptyState,
  esc,
  pageHeader,
  segmented,
  skeletonRows,
  sourceTooltip,
  statusDot,
  timeCell,
  topListCard,
  type ChipTone,
  type DataTableColumn,
  type DataTableRow,
  type RenderCtx,
  type TopListRow
} from '../index'
import type { QuestionsPayloadFull, SkillsPayloadFull } from '../../routes/insights'
import type { OperatorSettingsValue } from '../../routes/settings-store'

// ---------------------------------------------------------------------------------------------
// Local icon (Lucide, ISC) -- the same "copy the one path this page needs, do not edit
// icons.ts" pattern operator/src/render/pages/audit.ts and notifications.ts already establish
// for a glyph design-lead's icons.ts has no entry for.
// ---------------------------------------------------------------------------------------------

const CHECK_ICON_PATH = '<path d="M20 6 9 17l-5-5"/>'

// ---------------------------------------------------------------------------------------------
// Tabs (plan: "Tabs with a sliding underline"). The underline itself is drawn and animated by
// operator/client/pages/settings.ts (a real pixel offset can only be known after layout); this
// renders the strip markup plus the empty `<span>` the client positions.
// ---------------------------------------------------------------------------------------------

export const SETTINGS_TAB_IDS = ['tiers', 'value', 'skills', 'questions', 'health', 'access', 'data', 'session', 'appearance'] as const
export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number]

const SETTINGS_TAB_LABEL: Record<SettingsTabId, string> = {
  tiers: 'Tiers',
  value: 'Value',
  skills: 'Skills',
  questions: 'Questions',
  health: 'Platform health',
  access: 'Access',
  data: 'Data',
  session: 'Session',
  appearance: 'Appearance'
}

function settingsTabsHtml(active: SettingsTabId): string {
  const buttons = SETTINGS_TAB_IDS.map(
    (id) =>
      `<button type="button" class="settings-tab${id === active ? ' on' : ''}" role="tab" id="settings-tab-${id}" aria-selected="${id === active}" aria-controls="settings-panel-${id}" data-settings-tab="${id}">${esc(SETTINGS_TAB_LABEL[id])}</button>`
  ).join('')
  return `<div class="settings-tabs-wrap" data-settings-tabs>
    <div class="settings-tabs" role="tablist" aria-label="Settings sections">${buttons}</div>
    <span class="settings-tab-underline" data-settings-underline aria-hidden="true"></span>
  </div>`
}

function panel(id: SettingsTabId, active: SettingsTabId, body: string): string {
  return `<div class="settings-panel" id="settings-panel-${id}" role="tabpanel" aria-labelledby="settings-tab-${id}" data-settings-panel="${id}"${id === active ? '' : ' hidden'}>${body}</div>`
}

// ---------------------------------------------------------------------------------------------
// Tiers (plan: two cards, Métis / Métis Light, entitlement checkboxes, Save, seat count line).
// SSR renders the code-defined defaults (`DEFAULT_TIER_ENTITLEMENTS`, the same defaults
// `ensureTiersSeeded()` in operator/src/routes/groups.ts writes into `tiers` the first time that
// table is read empty) so a Worker whose entitlements were never customised shows the truth
// immediately, no JS required; the seat count and any customised entitlements arrive from `GET
// /v1/admin/tiers` (already shipped, task B1) the moment the client can fetch it.
// ---------------------------------------------------------------------------------------------

/** Exported so operator/client/pages/settings.ts can restate the consequence of unchecking an
 *  entitlement ("14 seats lose Listen on their next heartbeat") using the same label copy, never a
 *  second, driftable label map. */
export const ENTITLEMENT_COPY: Record<OperatorEntitlementKey, { label: string; help: string }> = {
  ask: { label: 'Ask', help: 'Ask Métis questions and get an answer.' },
  listen: { label: 'Listen', help: 'Passive meeting capture while Métis listens.' },
  recap: { label: 'Recap', help: 'Meeting recaps and the time-saved estimate.' },
  crm_push: { label: 'CRM push', help: 'Push a recap to a connected CRM.' },
  operator_keys: { label: 'Operator keys', help: 'Ask through provider keys the Operator holds, never a raw key on the seat.' },
  intelligence: { label: 'Intelligence', help: 'Screen and context intelligence while Métis is open.' },
  integrations: { label: 'Connectors', help: 'Reach connectors (CRMs, work tools, MCP servers) through the Operator.' }
}

const TIER_LABEL: Record<string, string> = { metis: 'Métis', 'metis-light': 'Métis Light' }

export interface TierApiRow {
  id: string
  label: string
  entitlements: string[]
  seats: number
}

function entitlementCheckboxHtml(tierId: string, key: OperatorEntitlementKey, checked: boolean): string {
  const copy = ENTITLEMENT_COPY[key]
  return `<label class="settings-checkbox">
    <input type="checkbox" name="entitlement" value="${esc(key)}" data-tier-entitlement ${checked ? 'checked' : ''}>
    <span class="settings-checkbox-box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${CHECK_ICON_PATH}</svg></span>
    <span class="settings-checkbox-text"><strong>${esc(copy.label)}</strong><span class="muted">${esc(copy.help)}</span></span>
  </label>`
}

/** One tier card, exported so both first paint and the client's post-fetch replace (real
 *  entitlements + a real seat count once `GET /v1/admin/tiers` answers) build byte-identical
 *  markup from the same wire shape. `seats: null` renders the honest "Loading..." caption
 *  first-paint always uses (SSR has no seat list to resolve tiers against without repeating
 *  operator/src/tiers.ts's async license-lookup logic in a file that does not own it). */
export function renderTierCard(row: { id: string; label: string; entitlements: string[]; seats: number | null }): string {
  const checked = new Set(row.entitlements)
  const boxes = OPERATOR_ENTITLEMENT_KEYS.map((key) => entitlementCheckboxHtml(row.id, key, checked.has(key))).join('')
  const seatsLine =
    row.seats == null
      ? `<span class="muted settings-tier-seats" data-tier-seats="${esc(row.id)}">Counting seats…</span>`
      : `<span class="muted settings-tier-seats" data-tier-seats="${esc(row.id)}">${row.seats} seat${row.seats === 1 ? '' : 's'} resolve to this tier${sourceTooltip('Seats whose license or approval currently resolves to this tier', 'tiers table joined against seats, live')}</span>`
  return `<article class="card pad-b10 settings-card" data-tier-card="${esc(row.id)}" data-stagger>
    <div class="settings-card-head">
      <h3>${esc(row.label)}</h3>
      ${seatsLine}
    </div>
    <form class="settings-tier-form" data-tier-form="${esc(row.id)}" data-baseline-entitlements="${esc(row.entitlements.join(','))}" data-tier-seats-count="${row.seats ?? ''}">
      <div class="settings-checkbox-list">${boxes}</div>
      ${saveButtonHtml('tier-save', row.id, 'Save')}
      <p class="settings-inline-msg muted" data-tier-msg="${esc(row.id)}"></p>
      <p class="settings-inline-msg" data-tier-consequence="${esc(row.id)}" aria-live="polite"></p>
    </form>
  </article>`
}

function saveButtonHtml(dataAttr: string, id: string, label: string): string {
  return `<button type="submit" class="btn primary settings-save" data-${esc(dataAttr)}="${esc(id)}">
    <span class="settings-save-label">${esc(label)}</span>
    <span class="settings-save-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${CHECK_ICON_PATH}</svg></span>
  </button>`
}

function renderTiersTab(): string {
  const tiers = defaultTiers(0).map((t) => ({
    id: t.id,
    label: TIER_LABEL[t.id] || t.label,
    entitlements: DEFAULT_TIER_ENTITLEMENTS[t.id] || [],
    seats: null as number | null
  }))
  return `<p class="settings-tab-intro">Every seat resolves to exactly one tier from its license or its plain approval. Turning an entitlement off here takes effect on that seat's next heartbeat.</p>
    <div class="settings-tiers-grid" data-tiers-grid>${tiers.map(renderTierCard).join('')}</div>`
}

// ---------------------------------------------------------------------------------------------
// Value (plan: hourly rate, currency, daily token budget, live count-up preview, time-saved
// explainer). `data.roi.hourlyRate`/`currency` are already the real stored settings
// (operator/src/routes/admin-core.ts's `valueSettings()` reads the same `operator_settings`
// table this tab writes); `dailyTokenBudgetPerSeat` is not in `DashboardPayload` (only Value
// itself needs it), so it starts as the honest "Loading..." placeholder the client's `GET
// /v1/admin/settings.json` fetch fills in.
// ---------------------------------------------------------------------------------------------

const CURRENCIES: OperatorSettingsValue['currency'][] = ['CAD', 'EUR', 'USD', 'GBP', 'CHF']

/** Live preview basis: `data.ops.timeSaved` is the SAME `recapMeetings(storedEvents)`-derived
 *  minute figure `data.roi.valueMinor` is computed from (operator/src/dashboard.ts), but unlike
 *  `valueMinor` it is never null just because no rate is stored yet -- exactly the number this
 *  tab needs to preview "what would Value be at the rate you are typing", independent of whatever
 *  rate happens to be saved right now. */
function valuePreviewHtml(savedMinutes: number | null, currency: string): string {
  if (savedMinutes == null) {
    return `<p class="muted settings-value-preview-empty" data-value-preview-empty>No recap data yet to estimate value from. The preview appears once at least one meeting has been recapped.</p>`
  }
  return `<div class="settings-value-preview" data-value-preview data-saved-minutes="${savedMinutes}">
    <div class="kpi-top"><span class="eyebrow eyebrow-flush">Value preview</span>${sourceTooltip(
      'Time saved this week times the hourly rate above',
      'recap events, last 7 days, times the hourly rate as typed'
    )}</div>
    <div class="n" data-value-preview-amount data-value-currency="${esc(currency)}">Set an hourly rate to see value</div>
    <p class="sub muted">Based on ${(savedMinutes / 60).toFixed(1)} hours saved this week.</p>
  </div>`
}

function timeSavedExplainer(): string {
  const a = DEFAULT_TIME_SAVED_ASSUMPTIONS
  const pct = Math.round(a.writeupRatio * 100)
  return `Time saved is an estimate, not a measurement: about ${pct}% of each recapped meeting's length, counted as the write-up avoided, floored at ${a.floorMin} minutes and capped at ${a.capMin} minutes per meeting.`
}

function renderValueTab(data: DashboardPayload): string {
  const rate = data.roi.hourlyRate
  const currency = data.roi.currency || 'USD'
  return `<article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Value</p>
    <p class="sub muted pad-b8">${esc(timeSavedExplainer())}</p>
    <form class="settings-value-form" data-value-form>
      <label>Hourly rate
        <input type="number" name="hourlyRate" min="0" max="10000" step="0.01" placeholder="Not set" value="${rate != null ? esc(String(rate)) : ''}" data-value-field="hourlyRate">
      </label>
      <label>Currency
        <select name="currency" data-value-field="currency">${CURRENCIES.map((c) => `<option value="${c}" ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <label>Daily token budget per seat
        <input type="number" name="dailyTokenBudgetPerSeat" min="0" step="1" placeholder="Loading…" disabled data-value-field="dailyTokenBudgetPerSeat">
      </label>
      ${saveButtonHtml('value-save', 'value', 'Save')}
      <p class="settings-inline-msg muted" data-value-msg></p>
    </form>
    ${valuePreviewHtml(data.ops.timeSaved, currency)}
  </article>`
}

// ---------------------------------------------------------------------------------------------
// Skills (plan: proposals board, diff view with added/removed tints, Edit toggle, Approve, Push,
// history). `data.proposals` is real (operator/src/dashboard.ts already builds it from the
// `proposals` table); evidence chips computed from question types/ratings and the push-adoption
// history both need `GET /v1/admin/skills.json` (task B5, this task's own
// operator/src/routes/insights.ts), so SSR shows a real board immediately with a "Loading
// evidence" placeholder chip row, and the history table starts as a skeleton.
// ---------------------------------------------------------------------------------------------

function diffViewHtml(diff: string): string {
  const lines = diff.split('\n')
  const rows = lines
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return `<div class="diff-line diff-add">${esc(line)}</div>`
      if (line.startsWith('-') && !line.startsWith('---')) return `<div class="diff-line diff-del">${esc(line)}</div>`
      return `<div class="diff-line diff-ctx">${esc(line) || '&nbsp;'}</div>`
    })
    .join('')
  return `<pre class="settings-diff-view" data-diff-view>${rows}</pre>`
}

/** Exported so operator/client/pages/settings.ts can patch one proposal card's evidence in place
 *  (replacing `[data-evidence-loading]`) once `GET /v1/admin/skills.json` answers, without
 *  re-rendering the whole card (which would tear out the actions operator/client/actions.ts's
 *  `initSkillActions()` already bound to it at boot -- see that client file's own top comment). */
export function evidenceChipsHtml(evidence?: { askCount: number; topTypes: { type: string; label: string; count: number }[]; ratings: { up: number; down: number } }): string {
  if (!evidence) {
    return `<div class="settings-evidence-chips muted" data-evidence-loading>Loading evidence…</div>`
  }
  const chips: string[] = [chip({ label: `${evidence.askCount} ask${evidence.askCount === 1 ? '' : 's'}, last 30 d` })]
  for (const t of evidence.topTypes) chips.push(chip({ label: `${t.count} ${t.label.toLowerCase()}` }))
  if (evidence.ratings.up || evidence.ratings.down) {
    chips.push(chip({ label: `${evidence.ratings.up} up / ${evidence.ratings.down} down`, tone: evidence.ratings.down > evidence.ratings.up ? 'warn' : 'ok' }))
  }
  return `<div class="settings-evidence-chips" data-evidence>${chips.join('')}</div>`
}

const PROPOSAL_STATUS_TONE: Record<string, ChipTone> = { pending: 'warn', approved: 'accent', rejected: 'danger', pushed: 'ok' }

export interface ProposalCardData {
  id: string
  skillId: string
  fromVersion: string
  status: string
  rationale: string
  diff: string
  createdBy: string
  createdAt: number
  now: number
  evidence?: { askCount: number; topTypes: { type: string; label: string; count: number }[]; ratings: { up: number; down: number } }
}

/** One proposal card, exported so first paint and the client's evidence-only patch (after `GET
 *  /v1/admin/skills.json`) share the exact same markup. `[data-approve]`/`[data-reject]`/
 *  `[data-push]`/`[data-draft]`/`[data-diff]` match operator/client/actions.ts's
 *  `initSkillActions()` contract byte for byte (no other page renders these attributes today, so
 *  this is the first and only place that wiring becomes reachable). */
export function renderProposalCard(p: ProposalCardData): string {
  const actions: string[] = [
    `<button type="button" class="tool" data-diff-edit-toggle="${esc(p.id)}" aria-pressed="false">Edit</button>`
  ]
  if (p.status === 'pending') {
    actions.push(`<button type="button" class="tool" data-approve="${esc(p.id)}">Approve</button>`)
    actions.push(`<button type="button" class="tool danger" data-reject="${esc(p.id)}">Reject</button>`)
  } else if (p.status === 'approved') {
    actions.push(`<button type="button" class="tool primary" data-push="${esc(p.id)}">Push</button>`)
  }
  return `<article class="card pad-b10 settings-proposal-card" data-proposal-card="${esc(p.id)}" data-stagger>
    <div class="settings-proposal-head">
      <div><strong>${esc(p.skillId)}</strong> ${chip({ label: p.status, tone: PROPOSAL_STATUS_TONE[p.status] || 'default' })}</div>
      <span class="muted">from v${esc(p.fromVersion)} · by ${esc(p.createdBy)} · ${timeCell(p.createdAt, p.now)}</span>
    </div>
    <p class="sub muted">${esc(p.rationale)}</p>
    ${evidenceChipsHtml(p.evidence)}
    ${diffViewHtml(p.diff)}
    <textarea class="settings-diff-edit" data-diff="${esc(p.id)}" hidden>${esc(p.diff)}</textarea>
    <div class="row settings-proposal-actions">${actions.join('')}</div>
  </article>`
}

export function renderSkillsBoard(proposals: ProposalCardData[]): string {
  if (!proposals.length) {
    return emptyState({
      title: 'No skill proposals yet.',
      description: 'A proposal appears here once a skill draft is created from recent Asks.'
    })
  }
  const order: Record<string, number> = { pending: 0, approved: 1, rejected: 2, pushed: 3 }
  const sorted = [...proposals].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt - a.createdAt)
  return sorted.map(renderProposalCard).join('')
}

const SKILLS_HISTORY_COLUMNS: DataTableColumn[] = [
  { key: 'skill', label: 'Skill' },
  { key: 'version', label: 'Version' },
  { key: 'pushed', label: 'Pushed' },
  { key: 'by', label: 'By' },
  { key: 'pulled', label: 'Pulled by seats' }
]

export function renderSkillsHistory(history: SkillsPayloadFull['history'], now: number): string {
  const rows: DataTableRow[] = history.map((h) => ({
    cells: {
      skill: esc(h.skillId),
      version: `<span class="mono">${esc(h.version)}</span>`,
      pushed: timeCell(h.pushedAt, now),
      by: esc(h.pushedBy),
      pulled: `${h.pulledBySeats} seat${h.pulledBySeats === 1 ? '' : 's'}${sourceTooltip('Seats whose most recent ask carried exactly this skill version', 'asks table, most recent ask per device')}`
    }
  }))
  return dataTable({
    columns: SKILLS_HISTORY_COLUMNS,
    rows,
    emptyTitle: 'Nothing pushed yet.',
    emptyDescription: 'A pushed skill version appears here with which seats have picked it up.'
  })
}

function renderSkillsTab(data: DashboardPayload, ctx: RenderCtx): string {
  const proposals: ProposalCardData[] = data.proposals.map((p) => ({
    id: p.id,
    skillId: p.skill_id,
    fromVersion: p.from_version,
    status: p.status,
    rationale: p.rationale,
    diff: p.diff,
    createdBy: p.created_by,
    createdAt: p.created_at,
    now: ctx.now
  }))
  return `<div class="settings-skills-board" data-skills-board>${renderSkillsBoard(proposals)}</div>
    <article class="card pad-b10">
      <p class="eyebrow">Push history</p>
      <div data-skills-history><div class="settings-history-skeleton" role="status" aria-label="Loading push history">${skeletonRows(2)}</div></div>
    </article>`
}

// ---------------------------------------------------------------------------------------------
// Questions (plan: type mix bars per range, coverage, by mode, ratings/error rates, latency
// percentiles, cache hit, provider/model mix, cost, needs-attention, audited Reveal per ask).
// `data.questions` (mix/byMode/coverage over the last 7 days, operator/src/dashboard.ts) renders
// the type mix immediately; everything range-scoped and everything past the basic mix comes from
// `GET /v1/admin/questions.json?range=` (this task's operator/src/routes/insights.ts).
// ---------------------------------------------------------------------------------------------

const QUESTIONS_RANGES: { id: string; label: string }[] = [
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 d' },
  { id: '30d', label: '30 d' }
]

export function renderQuestionTypeMixCard(mix: { bars: { type: string; label: string; count: number }[] }, coverage: number | null): string {
  const rows: TopListRow[] = mix.bars.map((b) => ({ label: b.label, barValue: b.count, cells: { count: String(b.count) } }))
  const footer = coverage == null ? 'No question type reported yet' : `${Math.round(coverage * 100)}% of asks report a type`
  return topListCard({
    labelHeader: 'Type',
    valueHeaders: [{ key: 'count', label: 'Asks' }],
    rows,
    emptyTitle: 'No asks in this range yet.',
    footerRight: footer
  })
}

function statPairHtml(label: string, value: string, formula: string, source: string): string {
  return statPairRawHtml(label, esc(value), formula, source)
}

/** Same shape as statPairHtml(), for the one case a stat's value is itself markup (`timeCell()`,
 *  which needs its own `data-ts` to be a real element for "last cron run ticks", plan 3.5b) --
 *  callers pass already-escaped or already-safe HTML, never raw user input. */
function statPairRawHtml(label: string, valueHtml: string, formula: string, source: string): string {
  return `<div class="settings-stat">
    <span class="muted settings-stat-label">${esc(label)}${sourceTooltip(formula, source)}</span>
    <span class="settings-stat-value">${valueHtml}</span>
  </div>`
}

/** Polar-to-cartesian for a ring segment, clockwise from 12 o'clock. */
function polarPoint(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

/** A donut arc for one clean percentage (plan 3.5b Settings row: "donut arcs draw in"). The
 *  background ring is a plain `<circle>`; the value is a single `<path>` arc, `data-draw-path` so
 *  operator/client/pages/settings.ts calls the shared `drawPath()` helper (operator/client/
 *  motion.ts) on it exactly once the moment real data replaces this tab's loading skeleton --
 *  reduced motion (drawPath's own gate) renders it fully drawn immediately either way. Clamped
 *  just under 100% because a single SVG arc command cannot describe a complete circle. */
function donutRingHtml(pct: number | null, label: string): string {
  if (pct == null) {
    return `<div class="settings-donut-wrap settings-donut-empty muted" role="img" aria-label="${esc(label)}, not reported">not reported</div>`
  }
  const clamped = Math.max(0, Math.min(0.999, pct))
  const cx = 32
  const cy = 32
  const r = 26
  const sweep = clamped * 360
  const end = polarPoint(cx, cy, r, sweep)
  const start = polarPoint(cx, cy, r, 0)
  const largeArc = sweep > 180 ? 1 : 0
  const d = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
  return `<div class="settings-donut-wrap">
    <svg class="settings-donut" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${esc(label)}, ${Math.round(clamped * 100)} percent">
      <circle cx="${cx}" cy="${cy}" r="${r}" class="settings-donut-track" fill="none" stroke-width="8"></circle>
      ${sweep > 0 ? `<path d="${d}" class="settings-donut-arc" fill="none" stroke-width="8" stroke-linecap="round" data-draw-path></path>` : ''}
    </svg>
    <span class="settings-donut-value">${Math.round(clamped * 100)}%</span>
  </div>`
}

export function renderQuestionsAnalytics(q: QuestionsPayloadFull): string {
  const pct = (n: number | null): string => (n == null ? 'not reported' : `${Math.round(n * 100)}%`)
  const ms = (n: number | null): string => (n == null ? 'not reported' : `${n.toLocaleString('en-US')} ms`)
  const stats = [
    statPairHtml('Latency, median', ms(q.latency.p50Ms), 'Median total response time', 'asks table, resolved range'),
    statPairHtml('Latency, p95', ms(q.latency.p95Ms), '95th percentile total response time', 'asks table, resolved range'),
    statPairHtml('Cost', q.cost ?? 'not reported', 'List-price estimate from tokens and cache reads', 'asks table, resolved range, provider list price')
  ].join('')
  const donuts = `<div class="settings-donuts-row">
    <div class="settings-donut-card">
      <span class="muted settings-stat-label">Positive rating${sourceTooltip('Up-ratings over every rated ask', 'asks table, resolved range')}</span>
      ${donutRingHtml(q.ratings.positiveRate, 'Positive rating')}
    </div>
    <div class="settings-donut-card">
      <span class="muted settings-stat-label">Error rate${sourceTooltip('Asks that ended in an error', 'asks table, resolved range')}</span>
      ${donutRingHtml(q.errorRate, 'Error rate')}
    </div>
    <div class="settings-donut-card">
      <span class="muted settings-stat-label">Cache hit rate${sourceTooltip('Cache reads over cache reads plus writes', 'asks table, resolved range')}</span>
      ${donutRingHtml(q.cache.hitRate, 'Cache hit rate')}
    </div>
  </div>`

  const byModeRows: DataTableRow[] = q.byMode.map((m) => ({
    cells: {
      mode: esc(m.mode),
      count: String(m.count),
      topType: m.topType ? esc(m.topType.label) : 'not reported',
      ratings: `${m.ratings.up} up / ${m.ratings.down} down`,
      errorRate: pct(m.errorRate),
      latency: ms(m.latencyP50Ms)
    }
  }))
  const byModeTable = dataTable({
    columns: [
      { key: 'mode', label: 'Mode' },
      { key: 'count', label: 'Asks' },
      { key: 'topType', label: 'Top type' },
      { key: 'ratings', label: 'Ratings' },
      { key: 'errorRate', label: 'Error rate' },
      { key: 'latency', label: 'Latency, median' }
    ],
    rows: byModeRows,
    emptyTitle: 'No asks in this range yet.'
  })

  const providerRows: TopListRow[] = q.providers.map((p) => ({ label: p.key, barValue: p.count, cells: { count: String(p.count) } }))
  const modelRows: TopListRow[] = q.models.map((m) => ({ label: m.key, barValue: m.count, cells: { count: String(m.count) } }))

  const attentionColumns: DataTableColumn[] = [
    { key: 'when', label: 'When' },
    { key: 'seat', label: 'Seat' },
    { key: 'mode', label: 'Mode' },
    { key: 'type', label: 'Type' },
    { key: 'issue', label: 'Issue' },
    { key: 'reveal', label: '' }
  ]
  const attentionRows: DataTableRow[] = q.needsAttention.map((a) => ({
    cells: {
      when: timeCell(a.ts, q.until),
      seat: esc(a.seat),
      mode: a.mode ? esc(a.mode) : 'not reported',
      type: a.questionType ? esc(QUESTION_TYPE_LABELS[a.questionType as keyof typeof QUESTION_TYPE_LABELS] || a.questionType) : 'not reported',
      issue: statusDot(a.outcome === 'error' ? { state: 'failed', label: 'Error' } : { state: 'pending', label: 'Rated down' }),
      reveal: `<button type="button" class="tool" data-reveal="${esc(a.id)}">Reveal</button>`
    }
  }))
  const attentionTable = dataTable({
    columns: attentionColumns,
    rows: attentionRows,
    emptyTitle: 'Nothing needs attention.',
    emptyDescription: 'No ask in this range ended in an error or a down rating.'
  })

  return `<article class="card pad-b10">${donuts}<div class="settings-stats-grid">${stats}</div></article>
    <article class="card pad-b10">
      <p class="eyebrow">By mode</p>
      ${byModeTable}
    </article>
    <div class="grid-2">
      <article class="card pad-b10">
        <p class="eyebrow">Providers</p>
        ${topListCard({ labelHeader: 'Provider', valueHeaders: [{ key: 'count', label: 'Asks' }], rows: providerRows, emptyTitle: 'No provider reported yet.' })}
      </article>
      <article class="card pad-b10">
        <p class="eyebrow">Models</p>
        ${topListCard({ labelHeader: 'Model', valueHeaders: [{ key: 'count', label: 'Asks' }], rows: modelRows, emptyTitle: 'No model reported yet.' })}
      </article>
    </div>
    <article class="card pad-b10">
      <p class="eyebrow">Needs attention</p>
      <p class="sub muted pad-b8">Text is never shown here. Reveal decrypts one ask and is audited every time.</p>
      ${attentionTable}
      <p id="reveal" class="settings-reveal-line mono"></p>
    </article>`
}

function renderQuestionsTab(data: DashboardPayload): string {
  const rangeSeg = segmented({ items: QUESTIONS_RANGES.map((r, i) => ({ id: r.id, label: r.label, active: i === 1 })), attrs: 'data-questions-range' })
  return `<div class="settings-tab-toolbar"><span class="muted">Range</span>${rangeSeg}</div>
    <article class="card pad-b10">
      <p class="eyebrow">Question types</p>
      <div data-questions-type-mix>${renderQuestionTypeMixCard(data.questions.mix, data.questions.coverage)}</div>
    </article>
    <div data-questions-analytics>
      <div class="settings-history-skeleton" role="status" aria-label="Loading question analytics">${skeletonRows(4)}</div>
    </div>`
}

// ---------------------------------------------------------------------------------------------
// Platform health (plan: bindings, Access config, D1 reachability/schema, last ingest per route,
// error/retention counters, worker version/built-at, last cron run, staging/production label).
// `data.keys.*Bound` already carries four of the five bindings for real; everything else needs
// `GET /health` (public, operator/src/index.ts) and `GET /v1/admin/health.json`
// (operator/src/routes/admin-core.ts), neither of which is part of `DashboardPayload`.
// ---------------------------------------------------------------------------------------------

/** `data-pop` (plan 3.5b Settings row: "Platform health: status dots ping once on load") is the
 *  generic pop-in hook operator/client/motion-bind.ts's `bindMotion()` already scans for on every
 *  render it is handed -- once at boot for these four real SSR bindings, and again by
 *  operator/client/pages/settings.ts the moment `GET /v1/admin/health.json` replaces the loading
 *  skeleton with the rest of this same helper's output. Wrapping rather than editing statusDot()
 *  itself (a shared primitive this page does not own, with no attribute passthrough) keeps the
 *  "ping" a plain, additive one-shot pop, never a loop (that stays beacon()'s exclusive job). */
function bindingRow(label: string, bound: boolean): string {
  return `<div class="settings-stat">
    <span class="muted settings-stat-label">${esc(label)}</span>
    <span class="settings-ping" data-pop>${statusDot({ state: bound ? 'live' : 'pending', label: bound ? 'Bound' : 'Not bound' })}</span>
  </div>`
}

export interface HealthEnriched {
  version: string
  builtAt: string | null
  env: string
  d1Ok: boolean
  schemaOk: boolean | null
  schemaMissing: string[]
  lastIngestAt: number | null
  lastCronAt: number | null
  sessionBound: boolean
  oauthBound: boolean
  teamDomainBound: boolean
  policyAudBound: boolean
}

export function renderPlatformHealthEnriched(h: HealthEnriched, now: number): string {
  const schemaLine =
    h.schemaOk == null
      ? 'not reported'
      : h.schemaOk
        ? 'every expected table is present'
        : `missing: ${h.schemaMissing.join(', ')}`
  return `<div class="settings-stats-grid">
    ${statPairHtml('Worker version', h.version, 'The build the Worker is running', 'GET /health')}
    ${statPairHtml('Built at', h.builtAt || 'not reported', 'When this build was produced', 'GET /health')}
    ${statPairHtml('Environment', h.env, 'Staging or production', 'GET /health')}
    ${statPairHtml('D1', h.d1Ok ? 'reachable' : 'unreachable', 'A live query against the bound database', 'GET /health')}
    ${statPairHtml('Schema', schemaLine, 'Every table this build expects to exist', 'GET /health')}
    ${statPairRawHtml('Last ingest', h.lastIngestAt != null ? timeCell(h.lastIngestAt, now) : 'not reported', 'Newest heartbeat or ask received', 'GET /health')}
    ${statPairRawHtml('Last cron run', h.lastCronAt != null ? timeCell(h.lastCronAt, now) : 'not reported', 'Most recent retention cron heartbeat', 'GET /health')}
  </div>
  <div class="settings-checkbox-list settings-bindings-grid">
    ${bindingRow('Session', h.sessionBound)}
    ${bindingRow('Cloudflare OAuth', h.oauthBound)}
    ${bindingRow('Access team domain', h.teamDomainBound)}
    ${bindingRow('Access policy audience', h.policyAudBound)}
  </div>`
}

function renderHealthTab(data: DashboardPayload): string {
  return `<article class="card pad-b10">
      <p class="eyebrow">Bindings</p>
      <p class="sub muted pad-b8">Whether a secret is bound, never its value.</p>
      <div class="settings-checkbox-list settings-bindings-grid">
        ${bindingRow('Ingest secret', data.keys.ingestBound)}
        ${bindingRow('Prompt key', data.keys.promptBound)}
        ${bindingRow('Skill signing key', data.keys.skillBound)}
        ${bindingRow('Vault key', data.keys.vaultBound)}
      </div>
    </article>
    <article class="card pad-b10">
      <p class="eyebrow">Platform</p>
      <div data-health-enriched>
        <div class="settings-history-skeleton" role="status" aria-label="Loading platform health">${skeletonRows(4)}</div>
      </div>
    </article>`
}

// ---------------------------------------------------------------------------------------------
// Access (plan lock 8b, plan 6.11 "Access": read-only truth about who can sign in, session
// lifetime, and what a seat authenticates with; states plainly there is no password form).
// `ADMIN_EMAILS` and `SESSION_REMINT_AFTER_MS` are the exact constants operator/src/access.ts
// enforces the allowlist and re-mint cadence with (`../../access`, a file this page does not
// own) - imported, not retyped, so this tab can never drift from the real allowlist. The 12-hour
// absolute session lifetime is `access.ts`'s private `SESSION_ABSOLUTE_TTL_MS` (not exported);
// stated here as a fact rather than duplicated as a second constant this page would then own.
// ---------------------------------------------------------------------------------------------

function msToHours(ms: number): number {
  return Math.round(ms / (60 * 60 * 1000))
}

function renderAccessTab(): string {
  return `<article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Who can sign in</p>
    <p class="sub muted pad-b8">Cloudflare Access, email-code only. There is no password form anywhere in the Operator - a seat authenticates with HMAC over a shared ingest secret, never a login.</p>
    <div class="settings-checkbox-list">
      ${ADMIN_EMAILS.map((email) => `<div class="settings-stat"><span class="muted settings-stat-label">Allowlisted</span><span class="settings-access-email mono">${esc(email)}</span></div>`).join('')}
    </div>
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Session lifetime</p>
    <div class="settings-stats-grid">
      ${statPairHtml('Re-minted after', `${msToHours(SESSION_REMINT_AFTER_MS)} hour of activity`, 'How often an active session gets a fresh cookie', 'operator/src/access.ts')}
      ${statPairHtml('Absolute lifetime', '12 hours', 'Signs out even an active session after this long', 'operator/src/access.ts')}
      ${statPairHtml('Seat authentication', 'HMAC, not a password', 'Every /v1/* request from a seat is signed with the shared ingest secret', 'operator/src/hmac.ts')}
    </div>
  </article>`
}

// ---------------------------------------------------------------------------------------------
// Data (plan 6.11 "Data": retention windows per table from retention.ts, what is encrypted, what
// is never stored, and the export links). `RETENTION_MS` (`../../retention`) and `EXPORT_TABLES`
// (`../../export/tables`) are the real constants those two files enforce, imported rather than
// restated so this tab can never quote a stale number.
// ---------------------------------------------------------------------------------------------

const RETENTION_TABLE_LABEL: Record<keyof typeof RETENTION_MS, string> = {
  events: 'Events',
  audit: 'Audit',
  asks: 'Asks',
  crm_sends: 'CRM sends',
  rate_limits: 'Rate limit windows',
  integration_grants: 'Connector credential grants',
  mcp_calls: 'Connector tool calls'
}

function msToDays(ms: number): number {
  return Math.round(ms / (24 * 60 * 60 * 1000))
}

function renderDataTab(): string {
  const retentionRows = (Object.keys(RETENTION_MS) as (keyof typeof RETENTION_MS)[])
    .map((key) => statPairHtml(RETENTION_TABLE_LABEL[key], `${msToDays(RETENTION_MS[key])} days`, 'How long this table is kept before the daily cron prunes it', 'operator/src/retention.ts'))
    .join('')
  return `<article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Retention</p>
    <p class="sub muted pad-b8">operator_settings is never pruned - a hand-set preference has no age. Every other table below is pruned by the same daily cron.</p>
    <div class="settings-stats-grid">${retentionRows}</div>
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Encrypted at rest</p>
    <p class="sub muted pad-b8">Provider keys (Keys page) and connector credentials (Connectors page) are AES-256-GCM, decrypted only for the one request that spends them. Never stored decrypted, never returned in any JSON or HTML response.</p>
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Never stored</p>
    <ul class="settings-never-list">
      <li>The seat's IP address. Geo comes from Cloudflare's request.cf only.</li>
      <li>Ask text in plaintext. Only AES-256-GCM ciphertext, decrypted for one audited Reveal at a time.</li>
      <li>Connector tool call arguments. mcp_calls audits the tool name, latency and outcome only.</li>
    </ul>
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Export</p>
    <p class="sub muted pad-b8">Every export is itself an audited row: table, format, row count and the filter set.</p>
    <div class="settings-export-grid">
      ${EXPORT_TABLES.map(
        (table) =>
          `<div class="settings-export-row"><span class="mono">${esc(table)}</span><span class="row"><a class="tool" href="/v1/admin/export.csv?table=${esc(table)}">CSV</a><a class="tool" href="/v1/admin/export.xlsx?table=${esc(table)}">Excel</a></span></div>`
      ).join('')}
    </div>
  </article>`
}

// ---------------------------------------------------------------------------------------------
// Session (plan: email, signed in since, expires, Sign out).
// ---------------------------------------------------------------------------------------------

function renderSessionTab(data: DashboardPayload): string {
  return `<article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Session</p>
    <div class="settings-stats-grid">
      ${statPairHtml('Signed in as', data.email, 'The Access identity on this request', 'Cloudflare Access')}
      ${statPairHtml('Signed in since', 'not reported', 'When this Access session was minted', 'not exposed by any Operator route today')}
      ${statPairHtml('Expires', 'not reported', 'When this Access session expires', 'not exposed by any Operator route today')}
    </div>
    <form method="post" action="/logout" class="pad-8-0"><button class="btn" type="submit">Sign out</button></form>
  </article>`
}

// ---------------------------------------------------------------------------------------------
// Appearance (plan: theme segmented control synced with the rail through theme.ts, density,
// reduced motion override). The theme control renders the exact `theme-seg`/`theme-btn`/
// `data-theme-choice` markup operator/src/render/shell.ts's rail control uses (a file this page
// does not own) so operator/client/theme.ts's own `[data-theme-choice]` selector already covers
// it identically; density and reduced motion start at the safe defaults `operator_settings`
// itself defaults to and are corrected to the stored value by the client's settings fetch.
// ---------------------------------------------------------------------------------------------

function renderAppearanceTab(ctx: RenderCtx): string {
  const theme = ctx.theme
  return `<article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Theme</p>
    <div class="theme-seg" role="radiogroup" aria-label="Theme">
      <button type="button" class="theme-btn" data-theme-choice="system" aria-pressed="${theme === 'system' ? 'true' : 'false'}">System</button>
      <button type="button" class="theme-btn" data-theme-choice="light" aria-pressed="${theme === 'light' ? 'true' : 'false'}">Light</button>
      <button type="button" class="theme-btn" data-theme-choice="dark" aria-pressed="${theme === 'dark' ? 'true' : 'false'}">Dark</button>
    </div>
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Density</p>
    ${segmented({ items: [{ id: 'comfortable', label: 'Comfortable', active: true }, { id: 'compact', label: 'Compact' }], attrs: 'data-density-seg' })}
  </article>
  <article class="card pad-b10 settings-card" data-stagger>
    <p class="eyebrow">Reduced motion</p>
    <p class="sub muted pad-b8">Follow system uses your OS setting. Reduce turns off every animation on this page, regardless of the OS.</p>
    ${segmented({ items: [{ id: 'system', label: 'Follow system', active: true }, { id: 'reduce', label: 'Reduce' }], attrs: 'data-motion-seg' })}
  </article>`
}

// ---------------------------------------------------------------------------------------------
// Page assembly.
// ---------------------------------------------------------------------------------------------

export function renderSettings(data: DashboardPayload, ctx: RenderCtx): string {
  const active: SettingsTabId = 'tiers'
  return `${pageHeader({ title: 'Settings', subtitle: 'Operator configuration.' })}
    ${settingsTabsHtml(active)}
    <div class="settings-content">
      ${panel('tiers', active, renderTiersTab())}
      ${panel('value', active, renderValueTab(data))}
      ${panel('skills', active, renderSkillsTab(data, ctx))}
      ${panel('questions', active, renderQuestionsTab(data))}
      ${panel('health', active, renderHealthTab(data))}
      ${panel('access', active, renderAccessTab())}
      ${panel('data', active, renderDataTab())}
      ${panel('session', active, renderSessionTab(data))}
      ${panel('appearance', active, renderAppearanceTab(ctx))}
    </div>`
}
