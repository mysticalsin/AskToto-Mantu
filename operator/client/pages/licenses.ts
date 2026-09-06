/**
 * Licenses page client init (plan 6.7, motion minimums plan 3.5b "Licenses" row). Owns the
 * Generate card's richer behaviour the plain global handler in operator/client/licenses.ts does
 * not cover: the duration segmented control, the optional group/tier selects (populated from
 * `GET /v1/admin/groups` and `GET /v1/admin/tiers`, plan 6.7's stated data sources), the once-
 * string reveal (shimmer sweep, Copy with a clipboard-API-or-Select fallback, Copy pulse) and the
 * FLIP insert of the freshly generated row into the issued table with an accent wash.
 *
 * Approve and Revoke stay on operator/client/licenses.ts's shared `data-license-approve` /
 * `data-license-revoke` handlers (already correct: confirm before Revoke, rerender() + toast
 * after, no reload) -- this file does not re-wire them.
 *
 * Generate deliberately never calls rerender(): a full-page refresh would immediately hide the
 * once-string strip again (a fresh server render always starts with it `hidden`), which would
 * violate plan 3.7b law 7 ("the once-string never disappears until Tony dismisses it"). The mint
 * response already carries every field the new row needs, so nothing is lost by not refetching.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import { renderIssuedLicenseRowHtml, renderIssuedLicenseTable, viewRowFromGenerate, type IssuedLicenseViewRow } from '../../src/render/pages/licenses'
import { api } from '../api'
import { currentPage, rerender } from '../main'
import { bindMotion } from '../motion-bind'
import { countUp, flash, flip, pop, press, shimmer, slideIn } from '../motion'
import { toast } from '../toasts'

interface CachedExtra {
  groups: { id: string; name: string; tier: string }[]
  tiers: { id: string; label: string }[]
}

let cachedExtra: CachedExtra | null = null
let extraLoading: Promise<CachedExtra> | null = null

/** Fetched once per page session, reused on every rerender (the fixture/static-preview build has
 *  no server behind it, so this fails closed to empty lists there -- the selects still work with
 *  just their "No group" / "Default" option, never a fabricated name). */
function loadExtra(): Promise<CachedExtra> {
  if (cachedExtra) return Promise.resolve(cachedExtra)
  if (extraLoading) return extraLoading
  extraLoading = Promise.all([api('/v1/admin/groups'), api('/v1/admin/tiers')])
    .then(([g, t]) => {
      const groups =
        g && g.ok && Array.isArray(g.groups)
          ? g.groups.map((x: Record<string, unknown>) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), tier: String(x.tier ?? '') }))
          : []
      const tiers =
        t && t.ok && Array.isArray(t.tiers)
          ? t.tiers.map((x: Record<string, unknown>) => ({ id: String(x.id ?? ''), label: String(x.label ?? '') }))
          : []
      cachedExtra = { groups, tiers }
      return cachedExtra
    })
    .catch(() => {
      cachedExtra = { groups: [], tiers: [] }
      return cachedExtra
    })
  return extraLoading
}

function populateSelect(select: HTMLSelectElement, items: { id: string; label: string }[], placeholder: string): void {
  const current = select.value
  select.textContent = ''
  const placeholderOpt = document.createElement('option')
  placeholderOpt.value = ''
  placeholderOpt.textContent = placeholder
  select.appendChild(placeholderOpt)
  for (const item of items) {
    const opt = document.createElement('option')
    opt.value = item.id
    opt.textContent = item.label
    select.appendChild(opt)
  }
  if (current && Array.from(select.options).some((o) => o.value === current)) select.value = current
}

/** Duration segmented control (plan 3.5b: "a sliding thumb (spring)"). The native
 *  `<select name="days">` stays the single source of truth (see licenses.ts's durationControl()
 *  doc comment); this only keeps the decorative buttons and thumb in sync with it, both ways. */
function bindDurationControl(root: HTMLElement): void {
  const control = root.querySelector<HTMLElement>('[data-duration-control]')
  if (!control) return
  const select = control.querySelector<HTMLSelectElement>('[data-duration-select]')
  const thumb = control.querySelector<HTMLElement>('[data-duration-thumb]')
  const buttons = Array.from(control.querySelectorAll<HTMLButtonElement>('[data-duration-btn]'))
  if (!select || !thumb) return

  function sync(): void {
    const value = select!.value
    const index = buttons.findIndex((b) => b.getAttribute('data-duration-btn') === value)
    if (index < 0) return
    thumb!.setAttribute('data-thumb-index', String(index))
    buttons.forEach((b, i) => {
      b.classList.toggle('on', i === index)
      b.setAttribute('aria-pressed', String(i === index))
    })
  }

  buttons.forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      select.value = btn.getAttribute('data-duration-btn') || ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  })
  select.addEventListener('change', sync)
  sync()
}

function buildRowNode(html: string): HTMLElement | null {
  const tmp = document.createElement('tbody')
  tmp.innerHTML = html
  return tmp.firstElementChild instanceof HTMLElement ? tmp.firstElementChild : null
}

/** Inserts the freshly minted license into the issued table (plan 3.5b: "the issued table
 *  inserts the new row with FLIP and an accent wash"). Two paths: the common one (a real
 *  `<table>` already there, prepend one `<tr>` through flip()) and the one FLIP alone cannot
 *  cover (the table was showing emptyState() -- there is no `<tbody>` to insert into, so the
 *  whole card is rebuilt with just this one row and its own stagger-in via bindMotion() stands
 *  in for FLIP on that specific transition). */
function insertIssuedRow(root: HTMLElement, row: IssuedLicenseViewRow): void {
  const wrap = root.querySelector<HTMLElement>('[data-licenses-issued-wrap]')
  if (!wrap) return
  const now = Date.now()
  const existingTable = wrap.querySelector<HTMLTableElement>('table#licenses-issued-table')
  if (existingTable) {
    const tbody = existingTable.querySelector('tbody')
    if (!tbody) return
    const node = buildRowNode(renderIssuedLicenseRowHtml(row, now))
    if (!node) return
    flip(tbody, () => tbody.prepend(node))
    flash(node)
    return
  }
  wrap.innerHTML = renderIssuedLicenseTable([row], now)
  bindMotion(wrap)
  const inserted = wrap.querySelector<HTMLElement>('tr[data-license-jti]')
  if (inserted) flash(inserted)
}

/** Copy with the clipboard API, a visible "Select" fallback when it is unavailable or fails
 *  (plan: "once-string strip with Copy (clipboard API with a visible 'Select' fallback)"), and a
 *  one-shot pulse on success (plan 3.5b). Once the fallback has been used, the button stays
 *  "Select" for the rest of the session rather than retrying a clipboard call already known to
 *  fail. Dismiss just hides the strip -- the string itself was never stored anywhere else. */
function bindOnceStrip(root: HTMLElement): void {
  const strip = root.querySelector<HTMLElement>('[data-licenses-once]')
  const input = root.querySelector<HTMLInputElement>('[data-licenses-once-value]')
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-licenses-once-copy]')
  const dismissBtn = root.querySelector<HTMLButtonElement>('[data-licenses-once-dismiss]')
  let clipboardOk = true

  if (copyBtn) {
    press(copyBtn)
    copyBtn.addEventListener('click', async () => {
      if (!input || !input.value) return
      if (clipboardOk && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(input.value)
          toast({ kind: 'ok', text: 'Copied to clipboard.' })
          pop(copyBtn)
          return
        } catch {
          clipboardOk = false
        }
      } else {
        clipboardOk = false
      }
      copyBtn.textContent = 'Select'
      input.select()
      toast({ kind: 'info', text: 'Clipboard unavailable. The string is selected, copy with Ctrl+C or Cmd+C.' })
    })
  }

  if (dismissBtn && strip && input) {
    dismissBtn.addEventListener('click', () => {
      strip.hidden = true
      input.value = ''
    })
  }
}

function revealOnceString(root: HTMLElement, license: string): void {
  const strip = root.querySelector<HTMLElement>('[data-licenses-once]')
  const input = root.querySelector<HTMLInputElement>('[data-licenses-once-value]')
  if (!strip || !input) return
  input.value = license
  strip.hidden = false
  shimmer(strip, true)
  setTimeout(() => shimmer(strip, false), 1400)
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-licenses-once-copy]')
  if (copyBtn) {
    copyBtn.textContent = 'Copy'
    pop(copyBtn)
  }
}

async function handleGenerateSuccess(
  root: HTMLElement,
  res: { license: string; jti: string; last4: string; days: number; exp: number; groupId?: unknown; tier?: unknown; member?: unknown },
  submittedGroupId: string
): Promise<void> {
  const emailHost = root.querySelector<HTMLElement>('[data-email]')
  const issuedBy = emailHost ? emailHost.getAttribute('data-email') : null
  const extra = await loadExtra()
  const groupId = typeof res.groupId === 'string' && res.groupId ? res.groupId : submittedGroupId || null
  const tier = typeof res.tier === 'string' && res.tier ? res.tier : null
  const member = typeof res.member === 'string' && res.member ? res.member : null
  let groupName: string | null = null
  if (groupId) {
    const match = extra.groups.find((g) => g.id === groupId)
    groupName = match ? match.name : groupId
  }
  const row = viewRowFromGenerate({ jti: res.jti, last4: res.last4, days: res.days, exp: res.exp, groupId, tier, member }, groupName, issuedBy, Date.now())
  revealOnceString(root, res.license)
  insertIssuedRow(root, row)
  toast({ kind: 'ok', text: 'License generated. Copy it now, it will not be shown again.' })
}

function bindGenerateForm(root: HTMLElement): void {
  const form = root.querySelector<HTMLFormElement>('[data-licenses-generate-form]')
  const submitBtn = root.querySelector<HTMLButtonElement>('[data-licenses-generate-submit]')
  if (submitBtn) press(submitBtn)
  if (!form) return
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(form)
    const days = Number(fd.get('days'))
    const groupId = String(fd.get('groupId') || '').trim()
    const tier = String(fd.get('tier') || '').trim()
    const body: Record<string, unknown> = { days }
    if (tier) body.tier = tier
    const endpoint = groupId ? `/v1/admin/groups/${encodeURIComponent(groupId)}/licenses/generate` : '/v1/admin/licenses/generate'
    const res = await api(endpoint, body)
    if (!res || !res.ok) {
      toast({ kind: 'error', text: (res && res.error) || 'Could not generate a license.' })
      return
    }
    await handleGenerateSuccess(root, res, groupId)
  })
}

function bindGroupAndTierSelects(root: HTMLElement): void {
  const groupSelect = root.querySelector<HTMLSelectElement>('[data-licenses-group]')
  const tierSelect = root.querySelector<HTMLSelectElement>('[data-licenses-tier]')
  if (!groupSelect && !tierSelect) return
  loadExtra().then((extra) => {
    if (groupSelect) populateSelect(groupSelect, extra.groups.map((g) => ({ id: g.id, label: g.name })), 'No group')
    if (tierSelect) populateSelect(tierSelect, extra.tiers.map((t) => ({ id: t.id, label: t.label })), 'Default')
  })
}

// ---------------------------------------------------------------------------------------------
// "Needs your review" (block 0, plan 6.7). QA blocker fix: Tony's own requirement ("seats
// awaiting approval have their own section ... with a nugget, so I can click and go through them
// quickly") plus plan 3.7b law 1's two-click Approve flow ("the rail badge takes you to Licenses
// > Needs your review, then one click per seat, or `a` per seat with no clicks at all"). Every
// mutation here reuses the same `/v1/admin/licenses/:id/approve|revoke` endpoints
// operator/client/licenses.ts's shared handlers call -- revoke is polymorphic server-side (jti or
// device id, operator/src/routes/admin-core.ts's `licenseOrSeatAction`), so this file never needs
// to know which one a given row is beyond what its own toast/segment bookkeeping cares about.
// ---------------------------------------------------------------------------------------------

const REVIEW_HINT_STORAGE_KEY = 'metis-licenses-review-keys-used'

interface ReviewRowPayload {
  kind: 'seat' | 'license'
  id: string
  title: string
  fields: { label: string; value: string }[]
}

function reviewBlockEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[data-review-block]')
}

/** Every row in one segment (or, with no `segment`, the currently visible pane) -- always a
 *  fresh DOM query, never a cached list, since rows are added/removed by both this file (row
 *  collapse) and a full `rerender()` (plan P0.4: never patch a stale reference). */
function reviewRows(block: HTMLElement, segment?: 'pending' | 'expiring'): HTMLElement[] {
  const pane = segment
    ? block.querySelector<HTMLElement>(`[data-review-pane="${segment}"]`)
    : block.querySelector<HTMLElement>('[data-review-pane]:not([hidden])')
  if (!pane) return []
  return Array.from(pane.querySelectorAll<HTMLElement>('[data-review-row]'))
}

function activeReviewSegmentId(block: HTMLElement): 'pending' | 'expiring' {
  const on = block.querySelector<HTMLElement>('[data-review-segmented] [data-segmented].on')
  return on && on.getAttribute('data-segmented') === 'expiring' ? 'expiring' : 'pending'
}

/** Direct set, no animation -- correct on mount (a normal page load never "flashes" a value that
 *  never actually changed, plan 3.5: flash is for a live-refresh change) and to zero the badge out
 *  entirely once both queues clear. `animate` is only ever true right after this file's own
 *  approve/revoke resolves, mirroring operator/client/pages/notifications.ts's identical
 *  setRailBadge()/updateRailBadgeAnimated() split for its own unseen-count badge. */
function setRailReviewBadge(count: number, animate: boolean): void {
  const link = document.querySelector<HTMLElement>('[data-nav="licenses"]')
  if (!link) return
  let badge = link.querySelector<HTMLElement>('[data-badge="licenses"]')
  const from = badge ? Number(badge.textContent) || 0 : 0
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'nav-count'
      badge.setAttribute('data-badge', 'licenses')
      link.appendChild(badge)
    }
    if (animate) {
      countUp(badge, count, { from })
      flash(badge)
    } else {
      badge.textContent = String(count)
    }
  } else if (badge) {
    if (animate) {
      flash(badge)
      window.setTimeout(() => badge?.remove(), 300)
    } else {
      badge.remove()
    }
  }
}

/** Runs once per mount (boot, and after every `rerender('licenses')`): pushes this page's own,
 *  always-correct total (pending + expiring, read straight off the nugget this page just
 *  server-rendered) into the rail badge. The SSR badge ui.ts seeds at first paint is only an
 *  approximation (seats not yet approved, a superset that also counts revoked seats, and never
 *  expiring licenses); this corrects it without touching ui.ts or shell.ts, the same way
 *  notifications.ts's own unseen count is entirely client-owned. */
function correctRailBadgeAtMount(block: HTMLElement): void {
  const nugget = block.querySelector<HTMLElement>('[data-review-nugget]')
  const total = nugget ? Number(nugget.getAttribute('data-count-to')) || 0 : reviewRows(block, 'pending').length + reviewRows(block, 'expiring').length
  setRailReviewBadge(total, false)
}

function updateReviewSegmentLabel(block: HTMLElement, id: 'pending' | 'expiring', count: number): void {
  const btn = block.querySelector<HTMLElement>(`[data-review-segmented] [data-segmented="${id}"]`)
  if (btn) btn.textContent = id === 'pending' ? `Pending approval (${count})` : `Expiring soon (${count})`
}

function focusReviewRow(block: HTMLElement, row: HTMLElement | null): void {
  block.querySelectorAll<HTMLElement>('[data-review-row].is-focused').forEach((r) => r.classList.remove('is-focused'))
  if (!row) return
  row.classList.add('is-focused')
  pop(row)
  row.scrollIntoView({ block: 'nearest' })
}

function focusFirstReviewRow(block: HTMLElement): void {
  focusReviewRow(block, reviewRows(block, activeReviewSegmentId(block))[0] || null)
}

function currentReviewFocusRow(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>('[data-review-row].is-focused')
}

function moveReviewFocus(block: HTMLElement, delta: number): void {
  const rows = reviewRows(block, activeReviewSegmentId(block))
  if (!rows.length) return
  const current = currentReviewFocusRow(block)
  const idx = current ? rows.indexOf(current) : -1
  const next = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + delta))
  focusReviewRow(block, rows[next])
}

// ---------------------------------------------------------------------------------------------
// Segments (persisted via a `?queue=` URL param, the same pattern operator/client/pages/
// overview.ts uses for `?range=` -- never inside the hash itself, which operator/client/router.ts
// parses as an exact page id and would otherwise mis-route on the first unrecognised value).
// ---------------------------------------------------------------------------------------------

function setActiveReviewSegment(block: HTMLElement, id: 'pending' | 'expiring', persist: boolean): void {
  block.querySelectorAll<HTMLElement>('[data-review-segmented] [data-segmented]').forEach((b) => {
    const active = b.getAttribute('data-segmented') === id
    b.classList.toggle('on', active)
    b.setAttribute('aria-checked', active ? 'true' : 'false')
  })
  block.querySelectorAll<HTMLElement>('[data-review-pane]').forEach((pane) => {
    pane.hidden = pane.getAttribute('data-review-pane') !== id
  })
  focusFirstReviewRow(block)
  if (!persist) return
  try {
    const url = new URL(location.href)
    url.searchParams.set('queue', id)
    history.replaceState(null, '', url.toString())
  } catch {
    /* URL/history unavailable (non-browser test context): the visual toggle above still ran. */
  }
}

function applyReviewQueueFromUrl(block: HTMLElement): void {
  try {
    const id = new URL(location.href).searchParams.get('queue')
    if (id === 'pending' || id === 'expiring') setActiveReviewSegment(block, id, false)
  } catch {
    /* ignore */
  }
}

function wireReviewSegments(block: HTMLElement): void {
  block.querySelectorAll<HTMLButtonElement>('[data-review-segmented] [data-segmented]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-segmented')
      if (id === 'pending' || id === 'expiring') setActiveReviewSegment(block, id, true)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// Drawer (Enter opens, Esc closes -- plan 6.7 keyboard triage). The field HTML was already
// rendered server-side onto the row's own `data-review-json` (see operator/src/render/pages/
// licenses.ts's ReviewRowPayload doc comment): no second fetch, and the drawer can never show a
// value that disagrees with what the row itself says.
// ---------------------------------------------------------------------------------------------

function reviewDrawerEl(): HTMLElement | null {
  return document.getElementById('licenses-review-drawer')
}

function closeReviewDrawer(): void {
  const drawer = reviewDrawerEl()
  if (drawer) drawer.hidden = true
}

function openReviewDrawer(row: HTMLElement): void {
  const raw = row.getAttribute('data-review-json')
  const drawer = reviewDrawerEl()
  if (!raw || !drawer) return
  let payload: ReviewRowPayload
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  const title = drawer.querySelector('[data-drawer-title]')
  const body = drawer.querySelector<HTMLElement>('[data-drawer-body]')
  if (title) title.textContent = payload.title
  if (body) {
    body.innerHTML = payload.fields.map((f) => `<div class="seat-field"><span class="lbl">${esc(f.label)}</span><span class="val">${f.value}</span></div>`).join('')
  }
  drawer.hidden = false
  slideIn(drawer, 'right')
}

function wireReviewDrawerShell(root: HTMLElement): void {
  const closeBtn = root.querySelector<HTMLElement>('#licenses-review-drawer-close')
  if (closeBtn) closeBtn.addEventListener('click', closeReviewDrawer)
}

// ---------------------------------------------------------------------------------------------
// Approve / Revoke. Revoke is a two-click inline confirm on the button itself (plan 6.7: "confirm
// inline in the row, never a modal"), not `window.confirm` -- the button becomes its own
// confirmation, auto-reverting after 4s so an armed Revoke never sits waiting indefinitely.
// Approve carries no Undo action: the only way back through this API is Revoke, a materially
// different, non-reversible action (see operator/src/render/pages/licenses.ts's file header).
// ---------------------------------------------------------------------------------------------

function wireReviewConfirmButton(el: HTMLButtonElement, onConfirm: () => void | Promise<void>): void {
  const original = el.textContent || 'Revoke'
  let confirming = false
  let revert: ReturnType<typeof setTimeout> | null = null
  el.addEventListener('click', () => {
    if (!confirming) {
      confirming = true
      el.textContent = 'Confirm revoke'
      el.classList.add('is-confirming')
      revert = setTimeout(() => {
        confirming = false
        el.textContent = original
        el.classList.remove('is-confirming')
      }, 4000)
      return
    }
    if (revert) clearTimeout(revert)
    confirming = false
    el.textContent = original
    el.classList.remove('is-confirming')
    void onConfirm()
  })
}

/** Collapses the acted-on row (plan 3.5b: "the acted row collapses (250ms) and the next row's
 *  focus ring springs in"), updates the nugget/rail badge/segment count optimistically, moves
 *  focus, then lets a full `rerender()` land the authoritative server state a moment later (same
 *  sequence as operator/client/pages/notifications.ts's `runResolveAction` -> `collapseNoticeRow`
 *  -> `rerender()`) -- this also keeps the Seats and Issued-licenses tables further down the page
 *  in sync with whatever this block just did. */
async function resolveReviewRow(block: HTMLElement, btn: HTMLButtonElement, segment: 'pending' | 'expiring'): Promise<void> {
  const row = btn.closest<HTMLElement>('[data-review-row]')
  const siblingRows = reviewRows(block, segment)
  const idx = row ? siblingRows.indexOf(row) : -1
  if (row) {
    row.classList.add('lic-review-row-collapse')
    await new Promise<void>((resolve) => window.setTimeout(resolve, 260))
    row.remove()
  }
  updateReviewSegmentLabel(block, segment, reviewRows(block, segment).length)
  const nugget = block.querySelector<HTMLElement>('[data-review-nugget]')
  const remainingTotal = reviewRows(block, 'pending').length + reviewRows(block, 'expiring').length
  if (nugget) {
    const from = Number(nugget.textContent) || 0
    countUp(nugget, remainingTotal, { from })
    nugget.hidden = remainingTotal === 0
  }
  setRailReviewBadge(remainingTotal, true)
  const nextRows = reviewRows(block, activeReviewSegmentId(block))
  if (nextRows.length) focusReviewRow(block, nextRows[Math.max(0, Math.min(idx, nextRows.length - 1))])
  void rerender(currentPage())
}

async function runReviewApprove(block: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const deviceId = btn.getAttribute('data-review-approve') || ''
  if (!deviceId) return
  btn.disabled = true
  const res = await api(`/v1/admin/licenses/${encodeURIComponent(deviceId)}/approve`, {})
  if (!res || !res.ok) {
    btn.disabled = false
    toast({ kind: 'error', text: (res && res.error) || 'Could not approve the seat.' })
    return
  }
  toast({ kind: 'ok', text: 'Seat approved.' })
  await resolveReviewRow(block, btn, 'pending')
}

async function runReviewRevoke(block: HTMLElement, btn: HTMLButtonElement): Promise<void> {
  const id = btn.getAttribute('data-review-revoke') || ''
  if (!id) return
  const row = btn.closest<HTMLElement>('[data-review-row]')
  const kind = row ? row.getAttribute('data-review-kind') : null
  btn.disabled = true
  const res = await api(`/v1/admin/licenses/${encodeURIComponent(id)}/revoke`, {})
  if (!res || !res.ok) {
    btn.disabled = false
    toast({ kind: 'error', text: (res && res.error) || 'Could not revoke.' })
    return
  }
  toast({ kind: 'ok', text: kind === 'license' ? 'License revoked.' : 'Seat revoked.' })
  await resolveReviewRow(block, btn, kind === 'license' ? 'expiring' : 'pending')
}

function wireReviewActions(block: HTMLElement): void {
  block.querySelectorAll<HTMLButtonElement>('[data-review-approve]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => void runReviewApprove(block, btn))
  })
  block.querySelectorAll<HTMLButtonElement>('[data-review-revoke]').forEach((btn) => {
    press(btn)
    wireReviewConfirmButton(btn, () => runReviewRevoke(block, btn))
  })
}

// ---------------------------------------------------------------------------------------------
// Keyboard triage: j/k move, a approves, r revokes, Enter opens, Esc closes (plan 6.7, "the point
// of the block"). Bound once, globally, guarded by page visibility (`[data-page="licenses"]`
// isn't `hidden`) rather than by re-binding per row, since every page's markup coexists in the DOM
// at once (router.ts toggles `hidden`, it does not remove sections) and this file's own
// `initLicenses()` re-runs on every rerender. A click on the row's own button reuses the exact
// same confirm/press wiring `a`/`r` trigger here.
// ---------------------------------------------------------------------------------------------

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el instanceof HTMLElement && el.isContentEditable
}

function reviewKeysAlreadyUsed(): boolean {
  try {
    return window.localStorage.getItem(REVIEW_HINT_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function markReviewKeysUsed(block: HTMLElement): void {
  try {
    window.localStorage.setItem(REVIEW_HINT_STORAGE_KEY, '1')
  } catch {
    /* storage unavailable: the hint just does not remember this for next time */
  }
  const hint = block.querySelector<HTMLElement>('[data-review-hint]')
  if (hint) hint.hidden = true
}

let reviewKeysBound = false

function wireReviewKeyboardOnce(): void {
  if (reviewKeysBound) return
  reviewKeysBound = true
  document.addEventListener('keydown', (event) => {
    const page = document.querySelector<HTMLElement>('[data-page="licenses"]')
    if (!page || page.hidden) return
    const block = page.querySelector<HTMLElement>('[data-review-block]')
    if (!block) return
    const drawer = reviewDrawerEl()
    if (event.key === 'Escape') {
      if (drawer && !drawer.hidden) {
        event.preventDefault()
        closeReviewDrawer()
      }
      return
    }
    if (drawer && !drawer.hidden) return // drawer open: only Escape does anything
    if (isTypingTarget(document.activeElement)) return
    if (!['j', 'k', 'a', 'r', 'Enter'].includes(event.key)) return
    markReviewKeysUsed(block)
    if (event.key === 'j') {
      event.preventDefault()
      moveReviewFocus(block, 1)
      return
    }
    if (event.key === 'k') {
      event.preventDefault()
      moveReviewFocus(block, -1)
      return
    }
    const row = currentReviewFocusRow(block)
    if (!row) return
    if (event.key === 'Enter') {
      event.preventDefault()
      openReviewDrawer(row)
      return
    }
    if (event.key === 'a') {
      const approveBtn = row.querySelector<HTMLButtonElement>('[data-review-approve]')
      if (approveBtn) {
        event.preventDefault()
        approveBtn.click()
      }
      return
    }
    if (event.key === 'r') {
      const revokeBtn = row.querySelector<HTMLButtonElement>('[data-review-revoke]')
      if (revokeBtn) {
        event.preventDefault()
        revokeBtn.click()
      }
    }
  })
}

function bindReviewBlock(root: HTMLElement): void {
  const block = reviewBlockEl(root)
  if (!block) return
  wireReviewSegments(block)
  applyReviewQueueFromUrl(block)
  wireReviewActions(block)
  wireReviewDrawerShell(root)
  wireReviewKeyboardOnce()
  if (reviewKeysAlreadyUsed()) {
    const hint = block.querySelector<HTMLElement>('[data-review-hint]')
    if (hint) hint.hidden = true
  }
  focusFirstReviewRow(block)
  correctRailBadgeAtMount(block)
}

export function initLicenses(section: HTMLElement, data: DashboardPayload | null): void {
  void data
  const root = section.querySelector<HTMLElement>('.licenses-page') || section
  bindReviewBlock(root)
  bindDurationControl(root)
  bindGenerateForm(root)
  bindOnceStrip(root)
  bindGroupAndTierSelects(root)
}
