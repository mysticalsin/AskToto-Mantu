/**
 * Settings page client init (plan 6.11, task P1.10, backends B5/B6). SSR (operator/src/render/
 * pages/settings.ts) already renders every tab from real `DashboardPayload` fields with no JS
 * required; this file only (a) wires the interactions no shared client file provides (the sliding
 * tab underline, the diff Edit toggle, the density/motion/questions-range segmented controls, the
 * Value live count-up preview) and (b) patches in the five regions SSR could only show loading for
 * (tier seat counts, the daily token budget, skill evidence + push history, the full Questions
 * analytics, enriched Platform health) once `GET /v1/admin/tiers`, `GET /v1/admin/settings.json`,
 * `GET /v1/admin/skills.json`, `GET /v1/admin/questions.json` (this task's own
 * operator/src/routes/insights.ts) and `GET /health` + `GET /v1/admin/health.json` answer -- all
 * through the exact same pure render functions operator/src/render/pages/settings.ts exports, so
 * this file's markup never drifts from what the server would have produced.
 *
 * request() duplicates operator/client/api.ts's session-bearer protocol (ping GET /session once,
 * cache the bearer, attach it as `Authorization: Bearer`) because api() only ever issues GET or
 * POST and this page needs PATCH (tiers, settings.json); api.ts is a shared file this page does
 * not own. operator/client/pages/connectors.ts and groups.ts already carry the same, documented
 * duplication for the same reason.
 *
 * Skill actions (`[data-approve]` / `[data-reject]` / `[data-push]`): this page is the first ever
 * to render these attributes on real, load-bearing buttons (operator/client/actions.ts's
 * `initSkillActions()` already contains the exact matching handlers and binds them, once, at
 * boot, directly on whatever buttons the initial SSR happened to render). The problem: every time
 * a proposal's status changes, this page's own `rerender('settings')` (operator/client/main.ts)
 * throws away and rebuilds this section's whole subtree, and `reinitPage()` in that same shared
 * file has no `'settings'` branch to call `initSkillActions()` again the way it already does for
 * `'notifications'` -- so the freshly rendered Approve/Reject/Push buttons would otherwise have no
 * listener until the whole document reloads. Rather than ask for that one-line addition (which
 * would then double-fire alongside whatever this file does, since `initSkillActions()` binds
 * globally, not scoped to one page), this file owns the full interaction itself: a single
 * capture-phase click listener on the section element intercepts these three attributes ahead of
 * wherever the target's own bubble-phase listener would otherwise fire (a click that reaches an
 * ancestor's capture-phase listener has not yet reached the target's own listeners), stops
 * propagation unconditionally, and performs the exact same request `initSkillActions()` would
 * have -- so the mutation fires exactly once, from this file's own copy, whether the button is an
 * original SSR node or one this page rebuilt five rerenders later. Do not add a `'settings'`
 * branch calling `initSkillActions()` to `reinitPage()`: that would double the request every time
 * this page's own capture-phase handler also fires.
 *
 * Theme: the Appearance tab renders the exact same `theme-seg`/`theme-btn`/`data-theme-choice`
 * markup as the rail control (operator/src/render/shell.ts), so operator/client/theme.ts's own
 * boot-time `initTheme()` (`document.querySelectorAll('[data-theme-choice]')`, global, not scoped)
 * already binds this tab's buttons too on first paint -- nothing extra is needed there. The one
 * gap is the same `rerender('settings')` teardown described above: this file's own local
 * `applyThemeChoiceLocal()` duplicates theme.ts's small, fully idempotent apply/persist/repaint
 * sequence (same cookie name, same localStorage key, same attribute contract) so the control keeps
 * working after any such rerender. `theme.ts` exports nothing else to call instead (only
 * `initTheme()` itself, which would need to stay un-called here: it is unscoped, so calling it
 * again would re-bind the rail's own long-lived buttons a second time). The two implementations
 * can only ever agree on the resulting state (there is exactly one `data-theme` attribute, one
 * cookie, one localStorage key), so the harmless case where both fire once each, before any
 * rerender, on this tab's original SSR buttons, never produces a visible or functional difference.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc, relativeTime, skeletonRows } from '../../src/render'
import {
  evidenceChipsHtml,
  renderPlatformHealthEnriched,
  renderQuestionTypeMixCard,
  renderQuestionsAnalytics,
  renderSkillsHistory,
  renderTierCard,
  type HealthEnriched,
  type TierApiRow
} from '../../src/render/pages/settings'
import type { QuestionsPayloadFull, SkillsPayloadFull } from '../../src/routes/insights'
import type { OperatorSettingsValue } from '../../src/routes/settings-store'
import { bindMotion } from '../motion-bind'
import { countUp, drawPath, press, setReducedMotionOverride } from '../motion'
import { paintShoeyMap } from '../map'
import { rerender } from '../main'
import { toast } from '../toasts'

const WIRED_FLAG = 'settingsWired'
const TICKER_FLAG = 'settingsTicker'

// ---------------------------------------------------------------------------------------------
// Session-aware fetch (see the file doc comment above for why this cannot just be api()).
// ---------------------------------------------------------------------------------------------

let sessionBearer = ''

async function ensureSession(): Promise<void> {
  if (sessionBearer) return
  try {
    const ping = await fetch('/session', { method: 'GET', credentials: 'include', headers: { accept: 'application/json' } })
    const issued = ping.headers && ping.headers.get && ping.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
    const text = await ping.text()
    try {
      const j = JSON.parse(text) as { session?: string }
      if (j && j.session) sessionBearer = j.session
    } catch {
      /* not JSON: cookie-only session, nothing to cache */
    }
  } catch {
    /* offline or blocked: request() below still tries with cookies alone */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function request(path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<any> {
  await ensureSession()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (sessionBearer) headers.authorization = 'Bearer ' + sessionBearer
  let res: Response
  try {
    res = await fetch(path, { method, credentials: 'include', headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    return { ok: false, error: 'network failed' }
  }
  try {
    const issued = res.headers && res.headers.get && res.headers.get('X-Metis-Session')
    if (issued) sessionBearer = issued
  } catch {
    /* header read blocked in some test/preview contexts: keep whatever bearer we had */
  }
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    // A non-JSON body here is never Settings' own copy to show verbatim: a Cloudflare Access
    // redirect after the session expires, a proxy timeout page or any other markup response would
    // otherwise dump raw tags into the inline error line the caller renders. Plain-text bodies
    // (still useful for debugging a real backend error) are kept; anything that looks like markup
    // falls back to a plain HTTP status instead.
    const trimmed = text ? text.trim() : ''
    const looksLikeMarkup = trimmed.startsWith('<')
    return { ok: false, error: trimmed && !looksLikeMarkup ? trimmed.slice(0, 180) : `HTTP ${res.status}` }
  }
}

// ---------------------------------------------------------------------------------------------
// Module state. One Settings section exists at a time.
// ---------------------------------------------------------------------------------------------

let cachedSettings: OperatorSettingsValue | null = null
const tierSeatsCache: Record<string, number> = {}
let lastPreviewValue = 0

function markSaved(btn: HTMLElement | null): void {
  if (!btn) return
  btn.classList.add('is-saved')
  window.setTimeout(() => btn.classList.remove('is-saved'), 1200)
}

function replaceWithHtml(old: HTMLElement, html: string): HTMLElement | null {
  const wrap = document.createElement('div')
  wrap.innerHTML = html
  const next = wrap.firstElementChild
  if (!(next instanceof HTMLElement)) return null
  old.replaceWith(next)
  return next
}

function wireSavePress(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.settings-save').forEach((btn) => press(btn))
}

// ---------------------------------------------------------------------------------------------
// Tabs: sliding underline (plan 3.5b "Tabs: sliding underline (spring)"). Position/width can only
// be known from real layout, never an inline style= on the tab buttons themselves (see
// operator/src/spa/css-settings.ts's own comment) -- the underline element is the one place a
// dynamic `.style.transform`/`.style.width` is written, same established pattern as
// operator/client/actions.ts's seat-meter/heartbeat-bar widths.
// ---------------------------------------------------------------------------------------------

function positionUnderline(section: HTMLElement, btn: HTMLElement): void {
  const wrap = section.querySelector<HTMLElement>('[data-settings-tabs]')
  const underline = section.querySelector<HTMLElement>('[data-settings-underline]')
  if (!wrap || !underline) return
  const wrapRect = wrap.getBoundingClientRect()
  const btnRect = btn.getBoundingClientRect()
  underline.style.width = `${btnRect.width}px`
  underline.style.transform = `translateX(${btnRect.left - wrapRect.left}px)`
}

function positionActiveUnderline(section: HTMLElement): void {
  const active = section.querySelector<HTMLElement>('[data-settings-tab].on') || section.querySelector<HTMLElement>('[data-settings-tab]')
  if (active) positionUnderline(section, active)
}

function activateTab(section: HTMLElement, id: string): void {
  let activeBtn: HTMLElement | null = null
  section.querySelectorAll<HTMLElement>('[data-settings-tab]').forEach((btn) => {
    const on = btn.getAttribute('data-settings-tab') === id
    btn.classList.toggle('on', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
    if (on) activeBtn = btn
  })
  section.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.getAttribute('data-settings-panel') !== id
  })
  if (activeBtn) positionUnderline(section, activeBtn)
}

// ---------------------------------------------------------------------------------------------
// Skills: diff Edit toggle (plan 6.11 "diff view ... Edit toggles a textarea").
// ---------------------------------------------------------------------------------------------

function toggleDiffEdit(btn: HTMLElement): void {
  const card = btn.closest<HTMLElement>('[data-proposal-card]')
  const id = btn.getAttribute('data-diff-edit-toggle')
  if (!card || !id) return
  const textarea = card.querySelector<HTMLTextAreaElement>(`[data-diff="${CSS.escape(id)}"]`)
  const diffView = card.querySelector<HTMLElement>('[data-diff-view]')
  if (!textarea || !diffView) return
  const startingEdit = textarea.hidden
  textarea.hidden = !startingEdit
  diffView.hidden = startingEdit
  btn.setAttribute('aria-pressed', startingEdit ? 'true' : 'false')
  btn.textContent = startingEdit ? 'Done' : 'Edit'
  if (startingEdit) textarea.focus()
}

// ---------------------------------------------------------------------------------------------
// Theme (see file doc comment: intentional, documented duplication of operator/client/theme.ts).
// ---------------------------------------------------------------------------------------------

type ThemeChoiceLocal = 'system' | 'light' | 'dark'

function isThemeChoice(v: string | null): v is ThemeChoiceLocal {
  return v === 'system' || v === 'light' || v === 'dark'
}

function currentThemeChoice(): ThemeChoiceLocal {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' || attr === 'dark' ? attr : 'system'
}

/** Re-syncs this section's own theme buttons to the real, current theme. Needed because
 *  operator/client/main.ts's `rerender()` always renders every page with a hardcoded
 *  `{ theme: 'light' }` context regardless of the actual theme (a pre-existing quirk in that
 *  shared file, out of this page's ownership) -- this corrects the visible `aria-pressed` state
 *  from what is really on `<html>` every time this section (re)mounts, without touching the
 *  `data-theme` attribute itself (already correct, set by theme.ts, unaffected by that quirk). */
function syncThemeButtons(section: HTMLElement): void {
  const choice = currentThemeChoice()
  section.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-choice') === choice ? 'true' : 'false')
  })
}

function applyThemeChoiceLocal(choice: ThemeChoiceLocal): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
  document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.getAttribute('data-theme-choice') === choice ? 'true' : 'false')
  })
  try {
    localStorage.setItem('metis-operator-theme', choice)
  } catch {
    /* private mode / storage blocked: the cookie below still carries the choice to the server */
  }
  try {
    document.cookie = `metis-operator-theme=${choice}; path=/; max-age=31536000; SameSite=Lax`
  } catch {
    /* cookie write blocked: theme still applies for this tab's lifetime */
  }
  paintShoeyMap()
}

// ---------------------------------------------------------------------------------------------
// Questions: audited Reveal (plan 6.11 "audited Reveal per ask"). Same `GET /v1/admin/asks/:id`
// contract as operator/client/actions.ts's own `[data-reveal]` handler; these specific buttons
// never exist at boot (they only appear after loadQuestions() below inserts real rows), so that
// shared, unscoped, boot-time-only handler never sees them -- this page must wire them itself.
// ---------------------------------------------------------------------------------------------

async function revealAsk(section: HTMLElement, id: string): Promise<void> {
  const out = section.querySelector<HTMLElement>('#reveal')
  if (!out) return
  const res = await request(`/v1/admin/asks/${encodeURIComponent(id)}`, 'GET')
  out.textContent = res && res.ok ? res.question || '(empty)' : (res && res.error) || 'reveal failed'
}

// ---------------------------------------------------------------------------------------------
// Segmented controls: density, reduced motion, Questions range.
// ---------------------------------------------------------------------------------------------

function setSegmentedActive(wrap: HTMLElement, id: string): void {
  wrap.querySelectorAll<HTMLElement>('[data-segmented]').forEach((b) => {
    const on = b.getAttribute('data-segmented') === id
    b.classList.toggle('on', on)
    b.setAttribute('aria-checked', on ? 'true' : 'false')
  })
}

async function onSegmentedClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const id = btn.getAttribute('data-segmented')
  if (!id) return
  const densityWrap = btn.closest<HTMLElement>('[data-density-seg]')
  const motionWrap = btn.closest<HTMLElement>('[data-motion-seg]')
  const rangeWrap = btn.closest<HTMLElement>('[data-questions-range]')

  if (densityWrap) {
    setSegmentedActive(densityWrap, id)
    const res = await request('/v1/admin/settings.json', 'PATCH', { density: id })
    if (!res || res.ok === false) toast({ kind: 'error', text: (res && res.error) || 'Could not save density.' })
    return
  }
  if (motionWrap) {
    setSegmentedActive(motionWrap, id)
    // 'reduce' forces reduced motion on; 'system' clears the override back to following the
    // OS/browser preference. There is no UI for forcing motion on regardless of the OS (the
    // stored setting only ever holds 'system' | 'reduce', operator/src/routes/settings-store.ts).
    setReducedMotionOverride(id === 'reduce' ? true : null)
    const res = await request('/v1/admin/settings.json', 'PATCH', { reducedMotion: id })
    if (!res || res.ok === false) toast({ kind: 'error', text: (res && res.error) || 'Could not save reduced motion.' })
    return
  }
  if (rangeWrap && (id === '24h' || id === '7d' || id === '30d')) {
    setSegmentedActive(rangeWrap, id)
    await loadQuestions(section, id)
  }
}

// ---------------------------------------------------------------------------------------------
// Tiers (plan 6.11: "two cards ... entitlement checkboxes and Save ... seats per tier").
// ---------------------------------------------------------------------------------------------

function patchTierCard(section: HTMLElement, row: { id: string; label: string; entitlements: string[]; seats: number | null }): void {
  const old = section.querySelector<HTMLElement>(`[data-tier-card="${CSS.escape(row.id)}"]`)
  if (!old) return
  const next = replaceWithHtml(old, renderTierCard(row))
  if (!next) return
  bindMotion(next)
  wireSavePress(next)
}

async function loadTiers(section: HTMLElement): Promise<void> {
  const res = await request('/v1/admin/tiers', 'GET')
  if (!res || res.ok === false || !Array.isArray(res.tiers)) return
  for (const row of res.tiers as TierApiRow[]) {
    tierSeatsCache[row.id] = row.seats
    patchTierCard(section, { id: row.id, label: row.label, entitlements: row.entitlements, seats: row.seats })
  }
}

async function submitTierForm(section: HTMLElement, form: HTMLFormElement): Promise<void> {
  const id = form.getAttribute('data-tier-form')
  if (!id) return
  const entitlements = Array.from(form.querySelectorAll<HTMLInputElement>('[data-tier-entitlement]:checked')).map((i) => i.value)
  const btn = form.querySelector<HTMLButtonElement>('.settings-save')
  const msg = section.querySelector<HTMLElement>(`[data-tier-msg="${CSS.escape(id)}"]`)
  if (btn) btn.disabled = true
  const res = await request(`/v1/admin/tiers/${encodeURIComponent(id)}`, 'PATCH', { entitlements })
  if (btn) btn.disabled = false
  if (res && res.ok && res.tier) {
    if (msg) {
      msg.textContent = ''
      msg.classList.remove('fail-loud')
    }
    patchTierCard(section, { id, label: res.tier.label, entitlements: res.tier.entitlements, seats: tierSeatsCache[id] ?? null })
    markSaved(section.querySelector<HTMLElement>(`[data-tier-card="${CSS.escape(id)}"] .settings-save`))
    toast({ kind: 'ok', text: 'Tier entitlements saved.' })
  } else {
    const errorText = (res && res.error) || 'Could not save entitlements.'
    if (msg) {
      msg.textContent = errorText
      msg.classList.add('fail-loud')
    }
    toast({ kind: 'error', text: errorText })
  }
}

// ---------------------------------------------------------------------------------------------
// Value (plan 6.11: "live count-up preview ... as the rate is typed").
// ---------------------------------------------------------------------------------------------

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString('en-US')}`
  }
}

function updateValuePreview(section: HTMLElement): void {
  const wrap = section.querySelector<HTMLElement>('[data-value-preview]')
  const amountEl = wrap ? wrap.querySelector<HTMLElement>('[data-value-preview-amount]') : null
  if (!wrap || !amountEl) return
  const savedMinutes = Number(wrap.getAttribute('data-saved-minutes'))
  const rateInput = section.querySelector<HTMLInputElement>('[data-value-field="hourlyRate"]')
  const currencySelect = section.querySelector<HTMLSelectElement>('[data-value-field="currency"]')
  const currency = currencySelect ? currencySelect.value : amountEl.getAttribute('data-value-currency') || 'USD'
  amountEl.setAttribute('data-value-currency', currency)
  const raw = rateInput ? rateInput.value.trim() : ''
  const rate = raw === '' ? null : Number(raw)
  if (rate == null || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(savedMinutes)) {
    lastPreviewValue = 0
    amountEl.textContent = 'Set an hourly rate to see value'
    return
  }
  const amount = (savedMinutes / 60) * rate
  countUp(amountEl, amount, { duration: 400, from: lastPreviewValue, format: (n) => formatCurrency(n, currency) })
  lastPreviewValue = amount
}

async function loadValueSettings(section: HTMLElement): Promise<void> {
  const res = await request('/v1/admin/settings.json', 'GET')
  if (!res || res.ok === false || !res.settings) return
  cachedSettings = res.settings as OperatorSettingsValue
  const budgetInput = section.querySelector<HTMLInputElement>('[data-value-field="dailyTokenBudgetPerSeat"]')
  if (budgetInput && document.activeElement !== budgetInput) {
    budgetInput.disabled = false
    budgetInput.placeholder = 'Not set'
    budgetInput.value = cachedSettings.dailyTokenBudgetPerSeat != null ? String(cachedSettings.dailyTokenBudgetPerSeat) : ''
  }
  // hourlyRate/currency already agree with the SSR value (same operator_settings source) --
  // corrected here only defensively, and never while the operator is actively editing the field.
  const rateInput = section.querySelector<HTMLInputElement>('[data-value-field="hourlyRate"]')
  const currencySelect = section.querySelector<HTMLSelectElement>('[data-value-field="currency"]')
  if (rateInput && document.activeElement !== rateInput) {
    rateInput.value = cachedSettings.hourlyRate != null ? String(cachedSettings.hourlyRate) : ''
  }
  if (currencySelect && document.activeElement !== currencySelect) currencySelect.value = cachedSettings.currency
  updateValuePreview(section)
}

async function submitValueForm(section: HTMLElement, form: HTMLFormElement): Promise<void> {
  const btn = form.querySelector<HTMLButtonElement>('.settings-save')
  const msg = section.querySelector<HTMLElement>('[data-value-msg]')
  const rateInput = form.querySelector<HTMLInputElement>('[data-value-field="hourlyRate"]')
  const currencySelect = form.querySelector<HTMLSelectElement>('[data-value-field="currency"]')
  const budgetInput = form.querySelector<HTMLInputElement>('[data-value-field="dailyTokenBudgetPerSeat"]')
  const patch: Record<string, unknown> = {
    hourlyRate: rateInput && rateInput.value.trim() !== '' ? Number(rateInput.value) : null,
    currency: currencySelect ? currencySelect.value : 'USD'
  }
  if (budgetInput && !budgetInput.disabled) {
    patch.dailyTokenBudgetPerSeat = budgetInput.value.trim() !== '' ? Math.round(Number(budgetInput.value)) : null
  }
  if (btn) btn.disabled = true
  const res = await request('/v1/admin/settings.json', 'PATCH', patch)
  if (btn) btn.disabled = false
  if (res && res.ok && res.settings) {
    cachedSettings = res.settings as OperatorSettingsValue
    if (msg) {
      msg.textContent = ''
      msg.classList.remove('fail-loud')
    }
    markSaved(btn)
    updateValuePreview(section)
    toast({ kind: 'ok', text: 'Value settings saved.' })
  } else {
    const errorText = (res && res.error) || 'Could not save Value settings.'
    if (msg) {
      msg.textContent = errorText
      msg.classList.add('fail-loud')
    }
    toast({ kind: 'error', text: errorText })
  }
}

// ---------------------------------------------------------------------------------------------
// Skills evidence + push history (plan 6.11, B5 GET /v1/admin/skills.json).
// ---------------------------------------------------------------------------------------------

async function loadSkills(section: HTMLElement): Promise<void> {
  const res = await request('/v1/admin/skills.json', 'GET')
  if (!res || res.ok === false) return
  const payload = res as SkillsPayloadFull
  for (const p of payload.proposals) {
    const card = section.querySelector<HTMLElement>(`[data-proposal-card="${CSS.escape(p.id)}"]`)
    const slot = card ? card.querySelector<HTMLElement>('[data-evidence-loading],[data-evidence]') : null
    if (!slot) continue
    replaceWithHtml(slot, evidenceChipsHtml(p.evidence))
  }
  const historyContainer = section.querySelector<HTMLElement>('[data-skills-history]')
  if (historyContainer) {
    historyContainer.innerHTML = renderSkillsHistory(payload.history, Date.now())
    bindMotion(historyContainer)
  }
}

// ---------------------------------------------------------------------------------------------
// Questions analytics (plan 6.11, B5 GET /v1/admin/questions.json?range=).
// ---------------------------------------------------------------------------------------------

function activeQuestionsRange(section: HTMLElement): '24h' | '7d' | '30d' {
  const on = section.querySelector<HTMLElement>('[data-questions-range] [data-segmented].on')
  const id = on ? on.getAttribute('data-segmented') : null
  return id === '24h' || id === '30d' ? id : '7d'
}

async function loadQuestions(section: HTMLElement, range: '24h' | '7d' | '30d'): Promise<void> {
  const analyticsContainer = section.querySelector<HTMLElement>('[data-questions-analytics]')
  const mixContainer = section.querySelector<HTMLElement>('[data-questions-type-mix]')
  if (analyticsContainer) {
    analyticsContainer.innerHTML = `<div class="settings-history-skeleton" role="status" aria-label="Loading question analytics">${skeletonRows(4)}</div>`
  }
  const res = await request(`/v1/admin/questions.json?range=${range}`, 'GET')
  if (!res || res.ok === false) {
    if (analyticsContainer) {
      analyticsContainer.innerHTML = `<p class="muted">Could not load question analytics${res && res.error ? `: ${esc(res.error)}` : '.'}</p>`
    }
    return
  }
  const payload = res as QuestionsPayloadFull
  if (mixContainer) {
    mixContainer.innerHTML = renderQuestionTypeMixCard(payload.mix, payload.coverage)
    bindMotion(mixContainer)
  }
  if (analyticsContainer) {
    analyticsContainer.innerHTML = renderQuestionsAnalytics(payload)
    bindMotion(analyticsContainer)
    analyticsContainer.querySelectorAll<SVGPathElement>('[data-draw-path]').forEach((p) => drawPath(p, 700))
  }
}

// ---------------------------------------------------------------------------------------------
// Platform health (plan 6.11, B6 GET /health + GET /v1/admin/health.json).
// ---------------------------------------------------------------------------------------------

async function loadHealth(section: HTMLElement): Promise<void> {
  const container = section.querySelector<HTMLElement>('[data-health-enriched]')
  if (!container) return
  const [pub, adm] = await Promise.all([
    fetch('/health', { credentials: 'include', headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .catch(() => null),
    request('/v1/admin/health.json', 'GET')
  ])
  if (!pub || pub.ok === false) {
    container.innerHTML = '<p class="muted">Platform health is not reachable right now.</p>'
    return
  }
  const schema = pub.schema
  const schemaOk = schema === 'ok' ? true : Array.isArray(schema) ? false : null
  const schemaMissing = Array.isArray(schema) ? (schema as string[]) : []
  const bindings = adm && adm.bindings ? adm.bindings : {}
  const access = adm && adm.access ? adm.access : {}
  const health: HealthEnriched = {
    version: String(pub.version || 'dev'),
    builtAt: pub.builtAt ?? null,
    env: String(pub.env || 'production'),
    d1Ok: pub.d1 === 'ok',
    schemaOk,
    schemaMissing,
    lastIngestAt: pub.lastIngestAt ?? null,
    lastCronAt: pub.lastCronAt ?? null,
    sessionBound: Boolean(bindings.session),
    oauthBound: Boolean(bindings.oauth),
    teamDomainBound: Boolean(access.teamDomain),
    policyAudBound: Boolean(access.policyAud)
  }
  container.innerHTML = renderPlatformHealthEnriched(health, Date.now())
  bindMotion(container)
}

// ---------------------------------------------------------------------------------------------
// 1s-scale ticker for "last cron run" style relative times (plan 3.5b: "'last cron run' ticks").
// A slower cadence than operator/client/pages/realtime.ts's per-second durations: nothing on this
// page is a running duration, only relative timestamps, whose display only ever changes at the
// minute/hour boundary.
// ---------------------------------------------------------------------------------------------

function startTicker(section: HTMLElement): void {
  if (section.dataset[TICKER_FLAG] === '1') return
  section.dataset[TICKER_FLAG] = '1'
  window.setInterval(() => {
    const now = Date.now()
    section.querySelectorAll<HTMLElement>('.time-cell[data-ts]').forEach((el) => {
      const ts = Number(el.getAttribute('data-ts'))
      if (Number.isFinite(ts)) el.textContent = relativeTime(ts, now)
    })
  }, 30_000)
}

// ---------------------------------------------------------------------------------------------
// Delegated, bind-once wiring (see file doc comment: survives every rerender('settings')).
// ---------------------------------------------------------------------------------------------

function onCaptureClick(section: HTMLElement, e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const approveBtn = target.closest<HTMLElement>('[data-approve]')
  if (approveBtn) {
    e.stopPropagation()
    const id = approveBtn.getAttribute('data-approve')
    if (id) void handleSkillAction(section, 'approve', id, { diff: section.querySelector<HTMLTextAreaElement>(`[data-diff="${CSS.escape(id)}"]`)?.value ?? '' })
    return
  }
  const rejectBtn = target.closest<HTMLElement>('[data-reject]')
  if (rejectBtn) {
    e.stopPropagation()
    const id = rejectBtn.getAttribute('data-reject')
    if (id) void handleSkillAction(section, 'reject', id, { reason: 'rejected in console' })
    return
  }
  const pushBtn = target.closest<HTMLElement>('[data-push]')
  if (pushBtn) {
    e.stopPropagation()
    const id = pushBtn.getAttribute('data-push')
    if (id) void handleSkillAction(section, 'push', id, {})
  }
}

const SKILL_ACTION_OK_TEXT: Record<'approve' | 'reject' | 'push', string> = {
  approve: 'Skill approved.',
  reject: 'Skill rejected.',
  push: 'Skill pushed.'
}
const SKILL_ACTION_FAIL_TEXT: Record<'approve' | 'reject' | 'push', string> = {
  approve: 'Could not approve the skill.',
  reject: 'Could not reject the skill.',
  push: 'Could not push the skill.'
}

async function handleSkillAction(_section: HTMLElement, action: 'approve' | 'reject' | 'push', id: string, body: unknown): Promise<void> {
  const res = await request(`/v1/admin/skills/${encodeURIComponent(id)}/${action}`, 'POST', body)
  if (res && res.ok) {
    toast({ kind: 'ok', text: SKILL_ACTION_OK_TEXT[action] })
    void rerender('settings')
  } else {
    toast({ kind: 'error', text: (res && res.error) || SKILL_ACTION_FAIL_TEXT[action] })
  }
}

function onClick(section: HTMLElement, e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const tabBtn = target.closest<HTMLElement>('[data-settings-tab]')
  if (tabBtn) {
    activateTab(section, tabBtn.getAttribute('data-settings-tab') || 'tiers')
    return
  }
  const diffToggle = target.closest<HTMLElement>('[data-diff-edit-toggle]')
  if (diffToggle) {
    toggleDiffEdit(diffToggle)
    return
  }
  const themeBtn = target.closest<HTMLElement>('[data-theme-choice]')
  if (themeBtn) {
    const choice = themeBtn.getAttribute('data-theme-choice')
    if (isThemeChoice(choice)) applyThemeChoiceLocal(choice)
    return
  }
  const segBtn = target.closest<HTMLElement>('[data-segmented]')
  if (segBtn) {
    void onSegmentedClick(section, segBtn)
    return
  }
  const revealBtn = target.closest<HTMLElement>('[data-reveal]')
  if (revealBtn) {
    const id = revealBtn.getAttribute('data-reveal')
    if (id) void revealAsk(section, id)
  }
}

function onSubmit(section: HTMLElement, e: SubmitEvent): void {
  const target = e.target
  if (!(target instanceof HTMLFormElement)) return
  if (target.matches('[data-tier-form]')) {
    e.preventDefault()
    void submitTierForm(section, target)
    return
  }
  if (target.matches('[data-value-form]')) {
    e.preventDefault()
    void submitValueForm(section, target)
  }
}

function onInput(section: HTMLElement, e: Event): void {
  const target = e.target
  if (target instanceof HTMLInputElement && target.matches('[data-value-field="hourlyRate"]')) updateValuePreview(section)
}

function onChange(section: HTMLElement, e: Event): void {
  const target = e.target
  if (target instanceof HTMLSelectElement && target.matches('[data-value-field="currency"]')) updateValuePreview(section)
}

function wireOnce(section: HTMLElement): void {
  if (section.dataset[WIRED_FLAG] === '1') return
  section.dataset[WIRED_FLAG] = '1'

  section.addEventListener('click', (e) => onCaptureClick(section, e), { capture: true })
  section.addEventListener('click', (e) => onClick(section, e))
  section.addEventListener('submit', (e) => onSubmit(section, e))
  section.addEventListener('input', (e) => onInput(section, e))
  section.addEventListener('change', (e) => onChange(section, e))
  window.addEventListener('resize', () => positionActiveUnderline(section))
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => positionActiveUnderline(section)).catch(() => {})
  }
  startTicker(section)
  wireSavePress(section)
}

/**
 * Called with the page's own `[data-page="settings"]` section element and, on a `rerender()`
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint. The
 * payload itself is unused here -- every real-data patch this page makes goes through its own
 * fetches to the JSON routes named in the file doc comment, not the dashboard payload directly
 * (plan D2's page-module split: those five regions are not part of `DashboardPayload`).
 */
export function initSettings(section: HTMLElement, _data: DashboardPayload | null): void {
  wireOnce(section)
  syncThemeButtons(section)
  positionActiveUnderline(section)
  void loadTiers(section)
  void loadValueSettings(section)
  void loadSkills(section)
  void loadQuestions(section, activeQuestionsRange(section))
  void loadHealth(section)
}
