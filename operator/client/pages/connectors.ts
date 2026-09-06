/**
 * Connectors page client init (plan 6.10, D9, task P1.9). Fetches GET /v1/admin/integrations (the
 * JSON route plan D2 lists for this page, since DashboardPayload carries no connector rows -- see
 * the top comment in operator/src/render/pages/connectors.ts) and renders it through
 * renderConnectedTable(); the catalog itself needs no fetch at all, it is code
 * (publicConnectorCatalog()), rendered once, identically, on the server and here.
 *
 * Every click in this section (catalog tiles, table rows, tools toggles, history toggle, the
 * drawer's Test/Save/Rotate/Revoke/reveal buttons) is wired through ONE delegated listener bound
 * once on the page's `[data-page="connectors"]` section (wireOnce(), below) rather than re-bound
 * per element -- both the Connected table and the connection drawer regenerate their innerHTML
 * often (every load, every open), and delegation means none of that regeneration ever needs to
 * re-attach a listener.
 *
 * request() duplicates operator/client/api.ts's session-bearer protocol (ping GET /session once,
 * cache the bearer, attach it as `Authorization: Bearer`) because api() only ever issues GET or
 * POST and this page needs PATCH too (editing an existing connection's scope/mode); api.ts is a
 * shared file this page does not own. operator/client/pages/groups.ts already carries the same,
 * documented duplication for the same reason.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { esc } from '../../src/render'
import {
  FALLBACK_TIER_OPTIONS,
  catalogByKind,
  publicConnectorCatalog,
  renderConnectedTable,
  renderConnectionDrawerHtml,
  renderConnectorRowHtml,
  renderHistoryToggle,
  renderProbeResultCard,
  type ConnectorSummary,
  type GroupOption,
  type PublicConnectorCatalogEntry,
  type TierOption
} from '../../src/render/pages/connectors'
import { bindMotion } from '../motion-bind'
import { flash, flip, pop, reduceMotion, shimmer, slideIn, staggerIn } from '../motion'
import { toast } from '../toasts'

// ---------------------------------------------------------------------------
// Session-aware fetch (see the file doc comment above for why this cannot just be api()).
// ---------------------------------------------------------------------------

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
    return { ok: false, error: text ? text.slice(0, 180) : 'HTTP ' + res.status }
  }
}

// ---------------------------------------------------------------------------
// Module state. One Connectors section exists at a time.
// ---------------------------------------------------------------------------

const catalogCache: PublicConnectorCatalogEntry[] = publicConnectorCatalog()
const catalogMap: Record<string, PublicConnectorCatalogEntry> = catalogByKind(catalogCache)

let connectedCache: ConnectorSummary[] = []
let cachedTiers: TierOption[] | null = null
let cachedGroups: GroupOption[] | null = null
let groupNameById: Record<string, string> = {}
let railListenerWired = false

async function ensureTiers(): Promise<TierOption[]> {
  if (cachedTiers) return cachedTiers
  const res = await request('/v1/admin/tiers', 'GET')
  if (res && res.ok !== false && Array.isArray(res.tiers) && res.tiers.length) {
    cachedTiers = (res.tiers as { id: unknown; label: unknown }[])
      .filter((t) => typeof t.id === 'string' && typeof t.label === 'string')
      .map((t) => ({ id: t.id as string, label: t.label as string }))
  }
  return cachedTiers && cachedTiers.length ? cachedTiers : FALLBACK_TIER_OPTIONS
}

async function ensureGroups(): Promise<GroupOption[]> {
  if (cachedGroups) return cachedGroups
  const res = await request('/v1/admin/groups', 'GET')
  if (res && res.ok !== false && Array.isArray(res.groups)) {
    const groups = (res.groups as { id: unknown; name: unknown }[])
      .filter((g) => typeof g.id === 'string' && typeof g.name === 'string')
      .map((g) => ({ id: g.id as string, name: g.name as string }))
    cachedGroups = groups
    groupNameById = {}
    for (const g of groups) groupNameById[g.id] = g.name
  }
  return cachedGroups || []
}

// ---------------------------------------------------------------------------
// Catalog tile search (plan 3.5b: "search filters tiles with FLIP").
// ---------------------------------------------------------------------------

function applyTileSearch(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#connectors-search')
  const q = (input && input.value ? input.value : '').trim().toLowerCase()
  section.querySelectorAll<HTMLElement>('[data-tile-grid]').forEach((grid) => {
    flip(grid, () => {
      grid.querySelectorAll<HTMLElement>('[data-catalog-tile]').forEach((tile) => {
        const hay = tile.getAttribute('data-q') || ''
        tile.hidden = q.length > 0 && hay.indexOf(q) < 0
      })
    })
    const categorySection = grid.closest<HTMLElement>('[data-category-section]')
    if (categorySection) {
      const anyVisible = Array.from(grid.querySelectorAll<HTMLElement>('[data-catalog-tile]')).some((t) => !t.hidden)
      categorySection.hidden = !anyVisible
    }
  })
}

function wireToolbar(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#connectors-search')
  if (input) input.addEventListener('input', () => applyTileSearch(section))
}

// ---------------------------------------------------------------------------
// Catalog tile connected-state markers (plan 3.5b: "the tile gains its green dot with a ping").
// ---------------------------------------------------------------------------

function connectionsCountByKind(rows: ConnectorSummary[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (r.status !== 'active') continue
    m.set(r.kind, (m.get(r.kind) || 0) + 1)
  }
  return m
}

function markTileConnected(tile: HTMLElement, count: number, animate: boolean): void {
  tile.classList.add('catalog-tile-connected')
  const label = `Connected, ${count} connection${count === 1 ? '' : 's'}`
  const html = `<span class="status-dot status-dot-live"><i aria-hidden="true"></i><span>${esc(label)}</span></span>`
  const existingDot = tile.querySelector<HTMLElement>('.status-dot')
  const existingNote = tile.querySelector<HTMLElement>('.catalog-tile-note')
  if (existingDot) {
    if (existingDot.textContent !== label) existingDot.outerHTML = html
  } else if (existingNote) {
    existingNote.outerHTML = html
  } else {
    tile.insertAdjacentHTML('beforeend', html)
  }
  if (animate && !reduceMotion()) {
    const dot = tile.querySelector<HTMLElement>('.status-dot')
    if (dot) pop(dot)
  }
}

function unmarkTileConnected(tile: HTMLElement): void {
  if (!tile.classList.contains('catalog-tile-connected')) return
  tile.classList.remove('catalog-tile-connected')
  const dot = tile.querySelector<HTMLElement>('.status-dot')
  if (dot) dot.remove()
}

function applyTileConnectionStates(section: HTMLElement, rows: ConnectorSummary[], animate: boolean): void {
  const counts = connectionsCountByKind(rows)
  section.querySelectorAll<HTMLElement>('[data-catalog-tile]').forEach((tile) => {
    const kind = tile.getAttribute('data-catalog-tile')
    const count = kind ? counts.get(kind) || 0 : 0
    if (count > 0) markTileConnected(tile, count, animate)
    else unmarkTileConnected(tile)
  })
}

function markTileConnectedByKind(section: HTMLElement, kind: string, animate: boolean): void {
  const tile = section.querySelector<HTMLElement>(`[data-catalog-tile="${CSS.escape(kind)}"]`)
  if (!tile) return
  const count = connectedCache.filter((c) => c.kind === kind && c.status === 'active').length
  markTileConnected(tile, count, animate)
}

// ---------------------------------------------------------------------------
// The Connected table.
// ---------------------------------------------------------------------------

async function loadConnected(section: HTMLElement): Promise<void> {
  const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
  const card = section.querySelector<HTMLElement>('[data-connectors-connected-card]')
  const errorEl = section.querySelector<HTMLElement>('[data-connectors-connected-error]')
  const historySlot = section.querySelector<HTMLElement>('[data-connectors-history-slot]')
  if (!root || !card) return
  if (errorEl) errorEl.hidden = true

  const res = await request('/v1/admin/integrations', 'GET')
  if (!res || res.ok === false) {
    card.hidden = false
    root.setAttribute('data-connectors-state', 'error')
    root.innerHTML = ''
    if (historySlot) historySlot.innerHTML = ''
    if (errorEl) {
      errorEl.hidden = false
      errorEl.textContent = (res && res.error) || 'Could not load connectors. Reopen this page to retry.'
    }
    return
  }

  connectedCache = Array.isArray(res.integrations) ? (res.integrations as ConnectorSummary[]) : []
  await ensureGroups()
  root.setAttribute('data-connectors-state', 'ready')

  const { html, activeCount, historyCount } = renderConnectedTable(connectedCache, Date.now(), catalogMap, groupNameById)
  if (activeCount + historyCount === 0) {
    card.hidden = true
    root.innerHTML = ''
    if (historySlot) historySlot.innerHTML = ''
    applyTileConnectionStates(section, [], false)
    return
  }
  card.hidden = false
  root.innerHTML = html
  bindMotion(root)
  if (historySlot) historySlot.innerHTML = renderHistoryToggle(historyCount)
  applyTileConnectionStates(section, connectedCache, false)
}

function insertConnectorRow(section: HTMLElement, row: ConnectorSummary): void {
  connectedCache = [row, ...connectedCache.filter((c) => c.id !== row.id)]
  const card = section.querySelector<HTMLElement>('[data-connectors-connected-card]')
  const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
  if (!card || !root) return
  card.hidden = false
  const table = root.querySelector<HTMLElement>('#connectors-table')
  const tbody = table ? table.querySelector('tbody') : null
  if (!tbody) {
    void loadConnected(section)
    return
  }
  const html = renderConnectorRowHtml(row, Date.now(), catalogMap, groupNameById)
  flip(tbody as HTMLElement, () => {
    ;(tbody as HTMLElement).insertAdjacentHTML('afterbegin', html)
  })
  const inserted = tbody.querySelector<HTMLElement>(`[data-connector-row="${CSS.escape(row.id)}"]`)
  if (inserted) {
    bindMotion(inserted)
    flash(inserted)
  }
}

function toggleTools(section: HTMLElement, btn: HTMLElement): void {
  const id = btn.getAttribute('data-tools-toggle')
  const list = id ? section.querySelector<HTMLElement>(`[data-tools-list="${CSS.escape(id)}"]`) : null
  if (!list) return
  const next = btn.getAttribute('aria-expanded') !== 'true'
  list.hidden = !next
  btn.setAttribute('aria-expanded', next ? 'true' : 'false')
  if (next) bindMotion(list)
}

function toggleConnectorsHistory(section: HTMLElement, btn: HTMLElement): void {
  const root = section.querySelector<HTMLElement>('[data-connectors-connected-root]')
  if (!root) return
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-connector-history-row]'))
  const next = btn.getAttribute('aria-expanded') !== 'true'
  rows.forEach((r) => {
    r.hidden = !next
  })
  btn.setAttribute('aria-expanded', next ? 'true' : 'false')
  btn.textContent = (next ? btn.getAttribute('data-hide-label') : btn.getAttribute('data-show-label')) || btn.textContent || ''
  if (next && !reduceMotion()) staggerIn(rows)
}

// ---------------------------------------------------------------------------
// The connection drawer.
// ---------------------------------------------------------------------------

function closeDrawer(section: HTMLElement): void {
  const drawer = section.querySelector<HTMLElement>('#connection-drawer')
  if (drawer) drawer.hidden = true
}

/**
 * plan 3.5b: "the drawer slides in with the logo growing from the tile (shared-element feel: the
 * drawer logo starts at the tile position and springs into place)." Built entirely from the
 * sanctioned motion.ts vocabulary (this page never writes its own WAAPI calls or keyframes): the
 * panel itself uses slideIn() (state change, plan 3.5), and the header logo uses pop() -- the same
 * helper already used everywhere else in this app for something appearing from nothing (delta
 * chips, tier badges, city dots) -- for its own "growing" entrance, rather than hand-computing a
 * FLIP offset from the tile's screen position for one image.
 */
async function openDrawer(section: HTMLElement, kind: string, existingId: string | null): Promise<void> {
  const entry = catalogMap[kind]
  const slot = section.querySelector<HTMLElement>('[data-connectors-drawer-slot]')
  if (!entry || !slot) return

  const existing = existingId ? connectedCache.find((c) => c.id === existingId) || null : null
  const needsTiersAndGroups = entry.availability !== 'needs-oauth'
  const [tiers, groups] = needsTiersAndGroups ? await Promise.all([ensureTiers(), ensureGroups()]) : [[], []]

  slot.innerHTML = renderConnectionDrawerHtml(entry, { tiers, groups, existing })
  const drawer = slot.querySelector<HTMLElement>('#connection-drawer')
  if (!drawer) return
  drawer.hidden = false
  slideIn(drawer, 'right')
  bindMotion(drawer)
  const logo = drawer.querySelector<HTMLElement>('.logo-glyph')
  if (logo && !reduceMotion()) pop(logo)
  const firstInput = drawer.querySelector<HTMLInputElement>('input:not([type="hidden"])')
  if (firstInput) firstInput.focus()
}

function collectConfig(drawer: HTMLElement, entry: PublicConnectorCatalogEntry): Record<string, string> {
  const config: Record<string, string> = {}
  entry.fields.forEach((f) => {
    if (f.key === 'credential') return
    const input = drawer.querySelector<HTMLInputElement>(`input[name="cfg_${f.key}"]`)
    if (input) config[f.key] = input.value.trim()
  })
  return config
}

function collectScope(drawer: HTMLElement): { tiers: string[]; groups: string[] } {
  const tiers = Array.from(drawer.querySelectorAll<HTMLInputElement>('input[name="scopeTier"]:checked')).map((i) => i.value)
  const groups = Array.from(drawer.querySelectorAll<HTMLInputElement>('input[name="scopeGroup"]:checked')).map((i) => i.value)
  return { tiers, groups }
}

function collectMode(drawer: HTMLElement): 'brokered' | 'direct' {
  const checked = drawer.querySelector<HTMLInputElement>('input[name="mode"]:checked')
  return checked && checked.value === 'direct' ? 'direct' : 'brokered'
}

function toggleCredentialReveal(btn: HTMLElement): void {
  const wrap = btn.closest<HTMLElement>('.connector-credential-wrap')
  const input = wrap ? wrap.querySelector<HTMLInputElement>('input[name="credential"]') : null
  if (!input) return
  const next = btn.getAttribute('aria-pressed') !== 'true'
  const swap = (): void => {
    input.type = next ? 'text' : 'password'
    btn.setAttribute('aria-pressed', next ? 'true' : 'false')
    btn.textContent = next ? 'Hide' : 'Show'
  }
  if (reduceMotion()) {
    swap()
    return
  }
  const CROSSFADE_MS = 90
  input.classList.add('is-crossfading')
  window.setTimeout(() => {
    swap()
    window.setTimeout(() => input.classList.remove('is-crossfading'), CROSSFADE_MS)
  }, CROSSFADE_MS)
}

/** plan 3.5b: "Test connection: the button shows a running shimmer, then the result card slides
 *  in; the tool list reveals row by row; read/write marks pop." A drawer Test on an existing
 *  connection also refreshes the Connected table so its status dot and last-test tooltip agree
 *  with what the drawer just showed. */
async function handleTestClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const drawer = btn.closest<HTMLElement>('#connection-drawer')
  if (!drawer) return
  const kind = drawer.getAttribute('data-connector') || ''
  const entry = catalogMap[kind]
  if (!entry) return
  const existingId = btn.getAttribute('data-connector-test') || ''
  const resultEl = drawer.querySelector<HTMLElement>('[data-connector-test-result]')
  const saveBtn = drawer.querySelector<HTMLButtonElement>('[data-connector-save]')

  shimmer(btn, true)
  btn.setAttribute('disabled', 'true')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: any
  if (existingId) {
    res = await request(`/v1/admin/integrations/${encodeURIComponent(existingId)}/test`, 'POST', {})
  } else {
    const credentialInput = drawer.querySelector<HTMLInputElement>('input[name="credential"]')
    const credential = credentialInput ? credentialInput.value.trim() : ''
    const config = collectConfig(drawer, entry)
    res = await request('/v1/admin/integrations/test', 'POST', { kind, credential, config })
  }
  shimmer(btn, false)
  btn.removeAttribute('disabled')

  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not run the test.' })
    if (saveBtn && !existingId) saveBtn.disabled = true
    return
  }
  if (resultEl) {
    resultEl.hidden = false
    resultEl.innerHTML = renderProbeResultCard(res.result)
    if (!reduceMotion()) slideIn(resultEl, 'bottom')
    bindMotion(resultEl)
  }
  if (saveBtn && !existingId) saveBtn.disabled = !res.result?.ok
  if (existingId) await loadConnected(section)
}

async function handleSaveClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const drawer = btn.closest<HTMLElement>('#connection-drawer')
  if (!drawer) return
  const kind = drawer.getAttribute('data-connector') || ''
  const entry = catalogMap[kind]
  if (!entry) return
  const existingId = btn.getAttribute('data-connector-save') || ''
  const scope = collectScope(drawer)
  const mode = collectMode(drawer)

  if (existingId) {
    const res = await request(`/v1/admin/integrations/${encodeURIComponent(existingId)}`, 'PATCH', { scope, mode })
    if (!res || res.ok === false) {
      toast({ kind: 'error', text: (res && res.error) || 'Could not save this connector.' })
      return
    }
    toast({ kind: 'ok', text: 'Connector saved.' })
    closeDrawer(section)
    await loadConnected(section)
    return
  }

  const labelInput = drawer.querySelector<HTMLInputElement>('input[name="label"]')
  const credentialInput = drawer.querySelector<HTMLInputElement>('input[name="credential"]')
  const label = (labelInput && labelInput.value.trim()) || entry.label
  const credential = credentialInput ? credentialInput.value.trim() : ''
  const config = collectConfig(drawer, entry)
  const res = await request('/v1/admin/integrations', 'POST', { kind, label, credential, config, scope, mode })
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not add this connector.' })
    return
  }
  toast({ kind: 'ok', text: `${label} added.` })
  closeDrawer(section)
  insertConnectorRow(section, res.integration as ConnectorSummary)
  markTileConnectedByKind(section, kind, true)
}

async function handleRevokeClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const id = btn.getAttribute('data-connector-revoke')
  if (!id) return
  const label = btn.getAttribute('data-connector-revoke-label') || 'this connector'
  if (!window.confirm(`Revoke ${label}? Seats using it lose access immediately.`)) return
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}/revoke`, 'POST', {})
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not revoke this connector.' })
    return
  }
  toast({ kind: 'ok', text: 'Connector revoked.' })
  closeDrawer(section)
  await loadConnected(section)
}

async function handleRowTestClick(section: HTMLElement, btn: HTMLElement): Promise<void> {
  const id = btn.getAttribute('data-connector-test')
  if (!id) return
  shimmer(btn, true)
  btn.setAttribute('disabled', 'true')
  const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}/test`, 'POST', {})
  shimmer(btn, false)
  btn.removeAttribute('disabled')
  if (!res || res.ok === false) {
    toast({ kind: 'error', text: (res && res.error) || 'Could not test this connector.' })
    return
  }
  toast({ kind: res.result && res.result.ok ? 'ok' : 'error', text: res.result && res.result.ok ? 'Connection test passed.' : 'Connection test failed.' })
  await loadConnected(section)
}

// ---------------------------------------------------------------------------
// Rotate dialog (plan 9, "no window.prompt": operator/src/render/pages/connectors.ts's
// renderRotateDialog() renders the shared masked dialog() primitive once; wired the same way
// operator/client/pages/keys.ts wires its own instance of the same primitive).
// ---------------------------------------------------------------------------

let rotateTargetId: string | null = null

function openRotateDialog(id: string): void {
  const overlay = document.getElementById('connector-rotate-dialog')
  if (!overlay) return
  rotateTargetId = id
  overlay.hidden = false
  const input = overlay.querySelector<HTMLInputElement>('.dialog-input')
  if (input) input.focus()
}

function wireRotateDialog(section: HTMLElement): void {
  const overlay = section.querySelector<HTMLElement>('#connector-rotate-dialog')
  if (!overlay) return
  const input = overlay.querySelector<HTMLInputElement>('.dialog-input')
  const reveal = overlay.querySelector<HTMLElement>('[data-dialog-reveal]')
  const cancel = overlay.querySelector<HTMLElement>('[data-dialog-cancel]')
  const confirm = overlay.querySelector<HTMLElement>('[data-dialog-confirm]')
  const panel = overlay.querySelector<HTMLElement>('.dialog-panel')

  const close = (): void => {
    overlay.hidden = true
    rotateTargetId = null
    if (input) input.value = ''
  }
  if (reveal && input) {
    reveal.addEventListener('click', () => {
      const showing = reveal.getAttribute('aria-pressed') === 'true'
      input.type = showing ? 'password' : 'text'
      reveal.setAttribute('aria-pressed', showing ? 'false' : 'true')
      reveal.textContent = showing ? 'Show' : 'Hide'
    })
  }
  if (cancel) cancel.addEventListener('click', close)
  if (confirm) {
    confirm.addEventListener('click', async () => {
      const credential = input ? input.value.trim() : ''
      const id = rotateTargetId
      if (!credential || !id) return
      const res = await request(`/v1/admin/integrations/${encodeURIComponent(id)}/rotate`, 'POST', { credential })
      close()
      if (!res || res.ok === false) {
        toast({ kind: 'error', text: (res && res.error) || 'Could not rotate this credential.' })
        return
      }
      toast({ kind: 'ok', text: 'Credential rotated.' })
      await loadConnected(section)
    })
  }
  if (panel) {
    const observer = new MutationObserver(() => {
      if (!overlay.hidden && !reduceMotion()) pop(panel)
    })
    observer.observe(overlay, { attributes: true, attributeFilter: ['hidden'] })
  }
}

// ---------------------------------------------------------------------------
// Delegated, bind-once wiring (survives every re-render of the Connected table and the drawer,
// since both live inside this same, never-replaced `section` element).
// ---------------------------------------------------------------------------

function wireDelegatedEvents(section: HTMLElement): void {
  section.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return

    if (target.closest('[data-connectors-add-open]')) {
      void openDrawer(section, 'custom-mcp', null)
      return
    }

    const toolsToggle = target.closest<HTMLElement>('[data-tools-toggle]')
    if (toolsToggle) {
      e.stopPropagation()
      toggleTools(section, toolsToggle)
      return
    }

    const historyToggle = target.closest<HTMLElement>('[data-connectors-history-toggle]')
    if (historyToggle) {
      toggleConnectorsHistory(section, historyToggle)
      return
    }

    const revealBtn = target.closest<HTMLElement>('[data-credential-reveal]')
    if (revealBtn) {
      toggleCredentialReveal(revealBtn)
      return
    }

    const testBtn = target.closest<HTMLElement>('[data-connector-test]')
    if (testBtn) {
      e.stopPropagation()
      const insideDrawer = testBtn.closest('#connection-drawer')
      void (insideDrawer ? handleTestClick(section, testBtn) : handleRowTestClick(section, testBtn))
      return
    }

    const rotateBtn = target.closest<HTMLElement>('[data-connector-rotate]')
    if (rotateBtn) {
      e.stopPropagation()
      const id = rotateBtn.getAttribute('data-connector-rotate')
      if (id) openRotateDialog(id)
      return
    }

    const revokeBtn = target.closest<HTMLElement>('[data-connector-revoke]')
    if (revokeBtn) {
      e.stopPropagation()
      void handleRevokeClick(section, revokeBtn)
      return
    }

    const saveBtn = target.closest<HTMLElement>('[data-connector-save]')
    if (saveBtn) {
      e.stopPropagation()
      void handleSaveClick(section, saveBtn)
      return
    }

    if (target.closest('#connection-drawer-close')) {
      closeDrawer(section)
      return
    }

    const tile = target.closest<HTMLElement>('[data-catalog-tile]')
    if (tile) {
      if (tile.hasAttribute('data-inert')) return
      const kind = tile.getAttribute('data-catalog-tile')
      if (kind) void openDrawer(section, kind, null)
      return
    }

    const row = target.closest<HTMLElement>('[data-connector-row]')
    if (row) {
      const id = row.getAttribute('data-connector-row')
      const kind = row.getAttribute('data-connector-kind')
      if (id && kind) void openDrawer(section, kind, id)
    }
  })

  section.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const drawer = section.querySelector<HTMLElement>('#connection-drawer')
      if (drawer && !drawer.hidden) {
        closeDrawer(section)
        return
      }
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof HTMLElement) {
      const row = e.target.closest<HTMLElement>('[data-connector-row]')
      if (row && e.target === row) {
        e.preventDefault()
        const id = row.getAttribute('data-connector-row')
        const kind = row.getAttribute('data-connector-kind')
        if (id && kind) void openDrawer(section, kind, id)
      }
    }
  })

  // plan 3.5b: Save is enabled only after a passing test; editing any field after a pass
  // invalidates it, so a stale "passing" state can never be saved without a fresh test.
  section.addEventListener('input', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    if (!target.matches('#connection-drawer input[name="credential"], #connection-drawer input[name^="cfg_"]')) return
    const saveBtn = section.querySelector<HTMLButtonElement>('#connection-drawer [data-connector-save]')
    if (saveBtn && !saveBtn.getAttribute('data-connector-save')) saveBtn.disabled = true
  })
}

// ---------------------------------------------------------------------------
// Rail "Add connector" (operator/client/nav.ts's initRailAddConnector() jumps to #connectors and
// dispatches this window event; plan 6.10 / 3.7 item 6: "The rail Add connector button opens the
// drawer on the Custom MCP tile.")
// ---------------------------------------------------------------------------

function wireRailAddConnector(section: HTMLElement): void {
  if (railListenerWired) return
  railListenerWired = true
  window.addEventListener('metis:add-connector', () => {
    void openDrawer(section, 'custom-mcp', null)
  })
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

const WIRED_FLAG = 'connectorsWired'

export function initConnectors(section: HTMLElement, _data: DashboardPayload | null): void {
  // operator/client/main.ts's boot sequence calls bindMotion(document.body) once, across every
  // server-rendered [data-page] section at once, before any PAGE_INIT runs -- staggerIn()'s delay
  // is `index * 40ms` against that single, whole-document [data-stagger] list, so a page as far
  // down NAV_IDS as this one (9th of 11) inherits a multi-second delay before its own catalog
  // tiles' entrance animation even starts (motion/mini's `animate()` fills backwards during that
  // delay, i.e. the tiles sit at opacity 0 the whole time -- confirmed independently reproducing
  // on operator/src/render/pages/keys.ts's vault table, so this is a shared-boot-sequence issue,
  // not specific to this page; see this task's final report for the exact patch to
  // operator/client/main.ts that fixes it at the source). Re-binding motion here, scoped to just
  // this section, gives the same tiles a small, section-local stagger index instead: the later
  // call's effect takes over the property from the earlier, still-delayed one.
  bindMotion(section)
  wireToolbar(section)
  wireRailAddConnector(section)
  if (section.dataset[WIRED_FLAG] !== '1') {
    section.dataset[WIRED_FLAG] = '1'
    wireDelegatedEvents(section)
    wireRotateDialog(section)
  }
  void loadConnected(section)
}
