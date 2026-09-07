/**
 * Notifications page client (plan 6.8). Owns everything client-side this page needs:
 *
 *  - Augments the server-rendered Seat/License/CRM/Skill notices with Connector notices
 *    (GET /v1/admin/integrations, filtered to health === 'failing') and Platform notices
 *    (GET /v1/admin/health.json for missing schema/unbound secrets, plus the public GET /health
 *    for "cron not run in 48 h") by calling the same renderNotifications() the Worker used for
 *    first paint, with `extra` filled in (plan D2: these two are not on DashboardPayload).
 *  - Wires every inline action (Approve seat, Retry CRM, Re-test connector, Revoke license) with
 *    the plan 3.5b resolve sequence: spring press, then on success the action cell crossfades to
 *    a check mark and the row collapses over 250ms before the page re-syncs with the server.
 *  - Mark seen: clicking a row (outside its button/link) or "Mark all seen" adds the notice's id
 *    to a localStorage set, fades the row to 60% opacity, and updates the rail's unseen badge
 *    with a count-down + flash, undoable via the toast's Undo. Also dispatches "metis:notices-seen"
 *    (plan 6.8) so the shell can pick the same signal up later.
 *  - Kind-chip filtering, a plain substring search, and a small column-visibility (View) popover
 *    persisted per-viewer in localStorage.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { iconSvg } from '../../src/render'
import {
  NOTICE_CHECK_ICON_PATH,
  renderNotifications,
  type ConnectorNoticeInput,
  type NotificationsExtra,
  type PlatformNoticeInput
} from '../../src/render/pages/notifications'
import { api } from '../api'
import { currentPage, rerender } from '../main'
import { bindMotion } from '../motion-bind'
import { countUp, flash, press } from '../motion'
import { toast } from '../toasts'

const SEEN_STORAGE_KEY = 'metis-notifications-seen-ids'
const SEEN_CAP = 500
const COLUMNS_STORAGE_KEY = 'metis-notifications-hidden-columns'
const OPTIONAL_COLUMN_KEYS = ['detail', 'profile', 'country', 'os'] as const

// ---------------------------------------------------------------------------------------------
// Seen-set (localStorage). Every read/write is wrapped: private browsing or a full quota must
// never throw out of this module, it just means mark-seen state does not persist this time.
// ---------------------------------------------------------------------------------------------

function readSeenIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function writeSeenIds(ids: Set<string>): void {
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(Array.from(ids).slice(-SEEN_CAP)))
  } catch {
    /* storage unavailable: mark-seen just does not survive a reload this time */
  }
}

function notificationsSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-page="notifications"]')
}

function computeUnseenCount(section: HTMLElement, seen: Set<string>): number {
  let unseen = 0
  section.querySelectorAll<HTMLElement>('[data-notice-row]').forEach((row) => {
    const id = row.getAttribute('data-notice-id')
    if (id && !seen.has(id)) unseen++
  })
  return unseen
}

function applySeenClasses(section: HTMLElement, seen: Set<string>): void {
  section.querySelectorAll<HTMLElement>('[data-notice-row]').forEach((row) => {
    const id = row.getAttribute('data-notice-id')
    row.classList.toggle('is-seen', Boolean(id && seen.has(id)))
  })
}

/** Direct set, create or remove -- no animation. Used only for the initial sync on every mount so
 *  a normal page load never "flashes" a value that never actually changed (plan 3.5: flash is for
 *  a live-refresh change, not first paint). */
function setRailBadge(count: number): void {
  const link = document.querySelector<HTMLElement>('[data-nav="notifications"]')
  if (!link) return
  const badge = link.querySelector<HTMLElement>('[data-badge="notifications"]')
  if (count > 0) {
    if (badge) {
      badge.textContent = String(count)
    } else {
      const created = document.createElement('span')
      created.className = 'nav-count'
      created.setAttribute('data-badge', 'notifications')
      created.textContent = String(count)
      link.appendChild(created)
    }
  } else if (badge) {
    badge.remove()
  }
}

/** Count-down + flash (plan 3.5b: "the unseen count in the rail badge flashes when it changes;
 *  mark-seen: ... the badge decrements with a count-down"). The rail badge lives outside this
 *  page's `[data-page]` section, so bindMotion()'s data-flash-key/data-count-to scan never
 *  reaches it -- this calls the same operator/client/motion.ts helpers directly instead. */
function updateRailBadgeAnimated(count: number): void {
  const link = document.querySelector<HTMLElement>('[data-nav="notifications"]')
  if (!link) return
  let badge = link.querySelector<HTMLElement>('[data-badge="notifications"]')
  const from = badge ? Number(badge.textContent) || 0 : 0
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'nav-count'
      badge.setAttribute('data-badge', 'notifications')
      link.appendChild(badge)
    }
    countUp(badge, count, { from })
    flash(badge)
  } else if (badge) {
    flash(badge)
    window.setTimeout(() => badge?.remove(), 300)
  }
}

function dispatchSeenEvent(unseenCount: number): void {
  window.dispatchEvent(new CustomEvent('metis:notices-seen', { detail: { unseenCount } }))
}

function markSeen(ids: string[]): void {
  if (!ids.length) return
  const seen = readSeenIds()
  let added = false
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      added = true
    }
  }
  if (!added) return
  writeSeenIds(seen)
  const section = notificationsSection()
  const unseen = section ? computeUnseenCount(section, seen) : 0
  if (section) applySeenClasses(section, seen)
  void updateRailBadgeAnimated(unseen)
  dispatchSeenEvent(unseen)
}

function unmarkSeen(ids: string[]): void {
  if (!ids.length) return
  const seen = readSeenIds()
  let removed = false
  for (const id of ids) {
    if (seen.delete(id)) removed = true
  }
  if (!removed) return
  writeSeenIds(seen)
  const section = notificationsSection()
  const unseen = section ? computeUnseenCount(section, seen) : 0
  if (section) applySeenClasses(section, seen)
  void updateRailBadgeAnimated(unseen)
  dispatchSeenEvent(unseen)
}

// ---------------------------------------------------------------------------------------------
// Inline action resolve sequence (plan 3.5b).
// ---------------------------------------------------------------------------------------------

function collapseNoticeRow(row: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const cell = row.querySelector<HTMLElement>('[data-notice-action-cell]')
    if (cell) {
      cell.innerHTML = `<span class="notice-action-done" aria-hidden="true">${iconSvg(NOTICE_CHECK_ICON_PATH)}</span>`
    }
    const id = row.getAttribute('data-notice-id')
    if (id) markSeen([id])
    window.setTimeout(() => {
      row.classList.add('notice-row-collapse')
      window.setTimeout(resolve, 260)
    }, 420)
  })
}

async function runResolveAction(
  button: HTMLButtonElement,
  opts: { path: string; confirmText?: string; successText: string; failText: string }
): Promise<void> {
  if (opts.confirmText && !window.confirm(opts.confirmText)) return
  const row = button.closest<HTMLElement>('[data-notice-row]')
  button.disabled = true
  const json = await api(opts.path, {})
  if (json && json.ok) {
    toast({ kind: 'ok', text: opts.successText })
    if (row) await collapseNoticeRow(row)
    rerender(currentPage())
    return
  }
  button.disabled = false
  toast({ kind: 'error', text: (json && json.error) || opts.failText })
}

interface ConnectorTestResponse {
  ok?: boolean
  health?: string
  error?: string
  result?: { summary?: string; error?: { message?: string } }
}

async function runRetestConnector(button: HTMLButtonElement, connectorId: string): Promise<void> {
  const row = button.closest<HTMLElement>('[data-notice-row]')
  button.disabled = true
  const json = (await api(`/v1/admin/integrations/${encodeURIComponent(connectorId)}/test`, {})) as ConnectorTestResponse
  if (json && json.ok && json.health === 'connected') {
    toast({ kind: 'ok', text: 'Connector is reachable again.' })
    if (row) await collapseNoticeRow(row)
    rerender(currentPage())
    return
  }
  button.disabled = false
  if (json && json.ok) {
    const message = (json.result && json.result.error && json.result.error.message) || (json.result && json.result.summary) || 'Still failing.'
    toast({ kind: 'error', text: `Still failing: ${message}` })
  } else {
    toast({ kind: 'error', text: (json && json.error) || 'Could not re-test the connector.' })
  }
}

function wireActions(section: HTMLElement): void {
  section.querySelectorAll<HTMLButtonElement>('[data-notice-action="approve-seat"]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      const deviceId = btn.getAttribute('data-device') || ''
      void runResolveAction(btn, {
        path: `/v1/admin/licenses/${encodeURIComponent(deviceId)}/approve`,
        successText: 'Seat approved.',
        failText: 'Could not approve the seat.'
      })
    })
  })
  section.querySelectorAll<HTMLButtonElement>('[data-notice-action="revoke-license"]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      const jti = btn.getAttribute('data-jti') || ''
      void runResolveAction(btn, {
        path: `/v1/admin/licenses/${encodeURIComponent(jti)}/revoke`,
        confirmText: 'Revoke this license? This cannot be undone.',
        successText: 'License revoked.',
        failText: 'Could not revoke the license.'
      })
    })
  })
  section.querySelectorAll<HTMLButtonElement>('[data-notice-action="retry-crm"]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      const crmId = btn.getAttribute('data-crm') || ''
      void runResolveAction(btn, {
        path: `/v1/admin/crm/${encodeURIComponent(crmId)}/retry`,
        successText: 'Retry queued.',
        failText: 'Could not queue the retry.'
      })
    })
  })
  section.querySelectorAll<HTMLButtonElement>('[data-notice-action="retest-connector"]').forEach((btn) => {
    press(btn)
    btn.addEventListener('click', () => {
      void runRetestConnector(btn, btn.getAttribute('data-connector') || '')
    })
  })
  // "Open skill" is a plain #settings navigation, not a mutation (no confirm/collapse sequence),
  // but it is still one of the five inline actions plan 3.5b names for "spring press".
  section.querySelectorAll<HTMLAnchorElement>('[data-notice-action="open-skill"]').forEach((link) => {
    press(link)
  })
}

// ---------------------------------------------------------------------------------------------
// Mark seen (row tap + "Mark all seen"), kind-chip filter, search.
// ---------------------------------------------------------------------------------------------

function wireMarkSeen(section: HTMLElement): void {
  // No press() on the row itself: every row contains its own action button, whose own press()
  // binding would double up with a row-level one on every click (pointerdown bubbles).
  section.querySelectorAll<HTMLElement>('[data-notice-row]').forEach((row) => {
    row.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('button, a')) return
      const id = row.getAttribute('data-notice-id')
      if (id) markSeen([id])
    })
  })
  const markAll = section.querySelector<HTMLButtonElement>('[data-mark-all-seen]')
  if (markAll) {
    press(markAll)
    markAll.addEventListener('click', () => {
      const ids = Array.from(section.querySelectorAll<HTMLElement>('[data-notice-row]:not(.is-seen)'))
        .map((row) => row.getAttribute('data-notice-id'))
        .filter((id): id is string => Boolean(id))
      if (!ids.length) {
        toast({ kind: 'info', text: 'Nothing new to mark.' })
        return
      }
      markSeen(ids)
      toast({ kind: 'ok', text: `Marked ${ids.length} as seen.`, undo: () => unmarkSeen(ids) })
    })
  }
}

function applyFilters(section: HTMLElement): void {
  const searchInput = section.querySelector<HTMLInputElement>('#notifications-search')
  const query = searchInput ? searchInput.value.trim().toLowerCase() : ''
  const activeChip = section.querySelector<HTMLElement>('[data-kind-chip].is-active')
  const kind = activeChip ? activeChip.getAttribute('data-kind-chip') : null
  let shown = 0
  section.querySelectorAll<HTMLElement>('[data-notice-row]').forEach((row) => {
    const rowKind = row.getAttribute('data-notice-kind')
    const text = row.getAttribute('data-q') || ''
    const visible = (!kind || rowKind === kind) && (!query || text.includes(query))
    row.hidden = !visible
    if (visible) shown++
  })
  const emptyEl = section.querySelector<HTMLElement>('[data-notice-filtered-empty]')
  if (emptyEl) emptyEl.hidden = shown > 0 || section.querySelectorAll('[data-notice-row]').length === 0
}

function wireFilters(section: HTMLElement): void {
  const searchInput = section.querySelector<HTMLInputElement>('#notifications-search')
  if (searchInput) {
    searchInput.addEventListener('input', () => applyFilters(section))
    searchInput.addEventListener('search', () => applyFilters(section))
  }
  section.querySelectorAll<HTMLButtonElement>('[data-kind-chip]').forEach((chip) => {
    press(chip)
    chip.addEventListener('click', () => {
      const wasActive = chip.classList.contains('is-active')
      section.querySelectorAll<HTMLElement>('[data-kind-chip]').forEach((other) => {
        other.classList.remove('is-active')
        other.setAttribute('aria-pressed', 'false')
      })
      if (!wasActive) {
        chip.classList.add('is-active')
        chip.setAttribute('aria-pressed', 'true')
      }
      applyFilters(section)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// View menu (column visibility), persisted per-viewer.
// ---------------------------------------------------------------------------------------------

let globalViewMenuCloseBound = false

/** Bound once for the life of the tab, guarded by the module-level flag: operator/client/main.ts
 *  calls initNotifications() again on every rerender() of this page (and once at boot for every
 *  page), and document/window never get replaced the way a `[data-page]` section's children do --
 *  binding this inside wireSection() every time would stack a new document-level listener on
 *  every rerender. */
function ensureGlobalViewMenuClose(): void {
  if (globalViewMenuCloseBound) return
  globalViewMenuCloseBound = true
  const closeAll = (): void => {
    document.querySelectorAll<HTMLElement>('[data-view-menu]:not([hidden])').forEach((menu) => {
      menu.hidden = true
    })
    document.querySelectorAll<HTMLElement>('[data-view-toggle][aria-expanded="true"]').forEach((btn) => {
      btn.setAttribute('aria-expanded', 'false')
    })
  }
  document.addEventListener('click', closeAll)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAll()
  })
}

function readHiddenColumns(): string[] {
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function syncColumnAttr(section: HTMLElement): void {
  const shell = section.querySelector<HTMLElement>('[data-notice-table-wrap]')
  const hidden = OPTIONAL_COLUMN_KEYS.filter((key) => {
    const checkbox = section.querySelector<HTMLInputElement>(`[data-col-toggle="${key}"]`)
    return checkbox ? !checkbox.checked : false
  })
  if (shell) shell.setAttribute('data-hide-cols', hidden.join(' '))
  try {
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(hidden))
  } catch {
    /* storage unavailable: column choice just does not persist this time */
  }
}

function initColumnVisibility(section: HTMLElement): void {
  const hidden = readHiddenColumns()
  OPTIONAL_COLUMN_KEYS.forEach((key) => {
    const checkbox = section.querySelector<HTMLInputElement>(`[data-col-toggle="${key}"]`)
    if (checkbox) checkbox.checked = !hidden.includes(key)
  })
  const shell = section.querySelector<HTMLElement>('[data-notice-table-wrap]')
  if (shell) shell.setAttribute('data-hide-cols', hidden.join(' '))
}

function wireViewMenu(section: HTMLElement): void {
  ensureGlobalViewMenuClose()
  const toggle = section.querySelector<HTMLButtonElement>('[data-view-toggle]')
  const menu = section.querySelector<HTMLElement>('[data-view-menu]')
  if (toggle && menu) {
    toggle.addEventListener('click', (event) => {
      event.stopPropagation()
      const willOpen = menu.hidden
      menu.hidden = !willOpen
      toggle.setAttribute('aria-expanded', String(willOpen))
    })
    menu.addEventListener('click', (event) => event.stopPropagation())
  }
  section.querySelectorAll<HTMLInputElement>('[data-col-toggle]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => syncColumnAttr(section))
  })
}

// ---------------------------------------------------------------------------------------------
// Connector / Platform augmentation (plan D2: not on DashboardPayload, fetched client-side).
// ---------------------------------------------------------------------------------------------

interface IntegrationsListResponse {
  ok?: boolean
  integrations?: Array<{
    id?: string
    kind?: string
    label?: string
    health?: string
    lastTestAt?: number | null
    lastTest?: { summary?: string; error?: { message?: string } } | null
  }>
}

async function fetchConnectorNotices(): Promise<ConnectorNoticeInput[]> {
  const json = (await api('/v1/admin/integrations')) as IntegrationsListResponse
  if (!json || json.ok !== true || !Array.isArray(json.integrations)) return []
  const now = Date.now()
  return json.integrations
    .filter((row) => row && row.health === 'failing' && typeof row.id === 'string')
    .map((row) => ({
      id: String(row.id),
      label: String(row.label || row.kind || 'Connector'),
      detail:
        (row.lastTest && row.lastTest.error && row.lastTest.error.message) ||
        (row.lastTest && row.lastTest.summary) ||
        'The last connection test failed.',
      ts: typeof row.lastTestAt === 'number' ? row.lastTestAt : now
    }))
}

/** Every label reads as a singular subject, because the title below completes it with "is not
 *  configured". "Cloudflare OAuth credentials is not configured" was the one that did not agree. */
const BINDING_LABEL: Record<string, string> = {
  ingest: 'Seat ingest secret',
  prompt: 'Prompt encryption key',
  skill: 'Skill signing key',
  vault: 'Vault encryption key',
  session: 'Session secret',
  oauth: 'The Cloudflare OAuth client'
}

/** The Worker secrets behind each binding, so the notice can say what to actually set rather than
 *  leaving "set this binding" for the reader to translate into a command. */
const BINDING_SECRETS: Record<string, string> = {
  ingest: 'OPERATOR_INGEST_SECRET',
  prompt: 'OPERATOR_PROMPT_KEY',
  skill: 'OPERATOR_SKILL_PRIVATE_KEY',
  vault: 'OPERATOR_VAULT_KEY',
  session: 'OPERATOR_SESSION_SECRET',
  oauth: 'CF_OAUTH_CLIENT_ID and CF_OAUTH_CLIENT_SECRET'
}

const CRON_STALE_MS = 48 * 60 * 60 * 1000

/** GET /v1/admin/health.json's exact shape belongs to operator/src/routes/admin-core.ts (not
 *  imported here: that file transitively pulls in D1/Worker-only modules that have no business
 *  in the browser bundle) -- `json` stays api()'s plain `any`, read defensively field by field,
 *  the same way operator/client/live.ts reads live.json without importing its server type.
 *
 *  Plan 6.8 also names "cron not run in 48 h" as a platform notice this page must surface, but
 *  `/v1/admin/health.json` (`healthPayload()`) does not report `lastCronAt` -- only the public
 *  `GET /health` route does (operator/src/index.ts's `lastCronAt(store)`, already exposed there
 *  for Settings > Platform health's "Last cron run" stat). Rather than adding a field to a
 *  shared route this page does not own, this fetches that same public route directly (no admin
 *  auth required, same pattern operator/client/pages/settings.ts's loadHealth() already uses). */
async function fetchPlatformNotices(): Promise<PlatformNoticeInput[]> {
  const [adminJson, pubJson] = await Promise.all([api('/v1/admin/health.json'), api('/health')])
  const now = Date.now()
  const notices: PlatformNoticeInput[] = []

  // Unlike every other route this page calls, health.json's own `ok` field is a health flag
  // (bindings present), not a request-success flag -- checking it here would skip exactly the
  // case this function exists to surface. api()'s own failure shape is the only thing that sets
  // `error` on this route (network failure, or a non-JSON/Access response); still read the
  // health fields whenever the object at least parsed.
  if (adminJson && typeof adminJson.error !== 'string') {
    const missing: unknown = adminJson.d1 && adminJson.d1.missing
    if (Array.isArray(missing) && missing.length) {
      notices.push({
        id: 'platform-d1-missing',
        title: 'Database schema incomplete',
        detail: `Missing tables: ${missing.filter((t): t is string => typeof t === 'string').join(', ')}`,
        ts: now
      })
    }
    const bindings: unknown = adminJson.bindings
    if (bindings && typeof bindings === 'object') {
      for (const [key, value] of Object.entries(bindings as Record<string, unknown>)) {
        if (value === false) {
          notices.push({
            id: `platform-binding-${key}`,
            title: `${BINDING_LABEL[key] || key} is not configured`,
            detail: BINDING_SECRETS[key]
              ? `Set ${BINDING_SECRETS[key]} with "wrangler secret put", then redeploy.`
              : 'Set this binding in the Worker environment so this capability works.',
            ts: now
          })
        }
      }
    }
  }

  // "Cron not run in 48 h" (plan 6.8). A missing timestamp is at least as stale as an old one --
  // the retention cron has never once reported a heartbeat -- so it surfaces the same notice
  // rather than being read as "no news, all clear".
  if (pubJson && typeof pubJson.error !== 'string') {
    const lastCronAt: unknown = pubJson.lastCronAt
    const lastCronMs = typeof lastCronAt === 'number' ? lastCronAt : null
    if (lastCronMs == null || now - lastCronMs > CRON_STALE_MS) {
      const hoursAgo = lastCronMs == null ? null : Math.floor((now - lastCronMs) / (60 * 60 * 1000))
      notices.push({
        id: 'platform-cron-stale',
        title: 'Cron has not run recently',
        detail:
          hoursAgo == null
            ? 'The retention cron has never reported a heartbeat.'
            : `The retention cron last ran ${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago.`,
        ts: now
      })
    }
  }

  return notices
}

async function loadExtra(section: HTMLElement, initialData: DashboardPayload | null): Promise<void> {
  let payload = initialData
  if (!payload) {
    const fetched = (await api('/v1/admin/dashboard')) as (DashboardPayload & { ok?: boolean }) | { ok: false }
    if (!fetched || (fetched as { ok?: boolean }).ok === false) return
    payload = fetched as DashboardPayload
  }
  const [connectors, platform] = await Promise.all([fetchConnectorNotices(), fetchPlatformNotices()])
  if (!connectors.length && !platform.length) return
  const extra: NotificationsExtra = { connectors, platform }
  section.innerHTML = renderNotifications(payload, { now: Date.now(), theme: 'light' }, extra)
  bindMotion(section)
  wireSection(section)
}

// ---------------------------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------------------------

function wireSection(section: HTMLElement): void {
  wireActions(section)
  wireMarkSeen(section)
  wireFilters(section)
  wireViewMenu(section)
  initColumnVisibility(section)
  const seen = readSeenIds()
  applySeenClasses(section, seen)
  setRailBadge(computeUnseenCount(section, seen))
}

export function initNotifications(section: HTMLElement, data: DashboardPayload | null): void {
  wireSection(section)
  void loadExtra(section, data)
}
