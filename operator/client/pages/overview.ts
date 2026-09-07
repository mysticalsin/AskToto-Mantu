/**
 * Overview page client init (plan 6.2, P1.2). Owns every client-side behaviour the Overview page
 * needs: tab switching inside the six top-list cards, the Filters popover and its row filtering,
 * the page-local search, the range/granularity toolbar controls (honest about the dashboard
 * route not filtering by range yet), the Generate license form (its own scoped handler, not the
 * shared `operator/client/licenses.ts` one -- that binds via a global `document.querySelectorAll`
 * with no idempotency guard, so calling it again from here on every Overview rerender would
 * attach a second listener to the Licenses page's own still-alive form), the area chart's
 * draw-in animation, the Live, 30 min tile's rolling one-minute bar strip fed by the shared
 * `metis:live` window event (operator/client/live.ts), and the Connectors card's own fetch of
 * GET /v1/admin/integrations (DashboardPayload carries no connector rows, same gap
 * operator/src/render/pages/connectors.ts documents for the full page).
 *
 * Called with the page's own `[data-page="overview"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint (the
 * section is already server-rendered, there is no freshly fetched payload yet). Delegated
 * listeners are bound once per section (guarded by `data-ov-bound`) so they keep working after
 * every rerender() without rebinding; per-render work (the chart draw-in, the copy button's
 * clipboard-availability check, seeding the live bars) runs on every call since those target
 * whatever is currently in the DOM.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { emptyState } from '../../src/render'
import type { ConnectorSummary } from '../../src/render/pages/connectors'
import { renderConnectorsCardRows, type OverviewConnectorSummary } from '../../src/render/pages/overview'
import { api, hasBackend } from '../api'
import { drawPath, flash, slideIn } from '../motion'
import { bindMotion } from '../motion-bind'
import { toast } from '../toasts'

const LIVE30_SLOTS = 30
const LIVE30_BAR_W = 6
const LIVE30_GAP = 2.5
const LIVE30_STEP = LIVE30_BAR_W + LIVE30_GAP
const LIVE30_H = 28

export function initOverview(section: HTMLElement, data: DashboardPayload | null): void {
  // operator/client/main.ts's boot sequence calls bindMotion(document.body) once, across every
  // server-rendered [data-page] section at once, before any PAGE_INIT runs -- staggerIn()'s delay
  // is `index * 40ms` against that single, whole-document [data-stagger] list, so Overview's own
  // top-list rows (1st of 11 in NAV_IDS, but the same math applies whichever position a page
  // lands at) inherit a delay driven by unrelated pages' content ahead of them in DOM order, not
  // by anything about this page. Every sibling page client module already re-binds motion locally
  // to override that (operator/client/pages/{connectors,audit,groups,licenses,notifications,
  // realtime,sessions}.ts); this call gives Overview's own tiles and rows the same section-scoped,
  // fast stagger instead of the shared, arbitrarily delayed one.
  //
  // Guarded: main.ts's own boot loop calls every page's init once for every page's section
  // *unconditionally*, including whichever pages are not the one currently showing (plan D1: all
  // pages render server-side, the router only toggles `hidden`) -- and Overview's own tabbed
  // top-list cards keep an inactive pane or two `hidden` by default even while the page itself is
  // the visible one. Either way, bindMotion()'s growBar()/staggerIn() can land on a `data-grow` or
  // `data-stagger` element that already has an in-flight WAAPI animation from the earlier, global
  // bindMotion(document.body) pass, inside an ancestor that is not currently rendered; the shared
  // motion.ts wrapper's restart-on-rebind path then calls commitStyles() on it and throws
  // `InvalidStateError: Target element is not rendered` -- confirmed independently reproducing the
  // identical way from Connectors' own bindMotion(section) call under the same hidden-section
  // condition, so this is a pre-existing defect in the shared primitives (operator/client/
  // motion.ts / motion-bind.ts, locked files this task does not own), not anything new here. Left
  // uncaught it would propagate out of main.ts's `PAGES.forEach` (which has no try/catch around
  // each page's call), aborting that loop and silently leaving every page after this one in
  // NAV_IDS order with no client-side wiring at all on that load. Catching it here keeps that
  // blast radius to this page's own animation (which, on the failure path, is already inside a
  // pane or a page nobody is looking at) instead of every other page's boot. See this task's
  // report for the exact motion-bind.ts / main.ts patch that fixes the shared root cause.
  try {
    bindMotion(section)
  } catch {
    /* pre-existing shared-primitive defect, see the comment above -- nothing to recover here */
  }
  drawAreaChart(section)
  setCopyFallbackLabel(section)
  seedLiveBarsIfEmpty(section, data)
  void loadConnectorsCard(section)

  if (section.dataset.ovBound === '1') return
  section.dataset.ovBound = '1'

  section.addEventListener('click', (e) => handleClick(section, e))
  section.addEventListener('keydown', (e) => handleKeydown(section, e))
  section.addEventListener('input', (e) => handleInput(section, e))
  section.addEventListener('submit', (e) => handleSubmit(section, e))
  document.addEventListener('click', (e) => closeFiltersOnOutsideClick(section, e))
  window.addEventListener('metis:live', (e) => handleLive(section, (e as CustomEvent).detail))

  applyRangeFromUrl(section)
}

// ---------------------------------------------------------------------------
// Area chart draw-in.
// ---------------------------------------------------------------------------

function drawAreaChart(section: HTMLElement): void {
  if (section.hidden) return
  const path = section.querySelector<SVGPathElement>('[data-ov-area-line]')
  if (!path) return
  try {
    drawPath(path, 800)
  } catch {
    /* getTotalLength() can throw on a detached or not-yet-laid-out path in some browsers; the
       chart already renders fully drawn without the animation, so this is safe to swallow. */
  }
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard fallback (task lock: "the button says 'Select' when the API is
// unavailable").
// ---------------------------------------------------------------------------

function hasClipboard(): boolean {
  try {
    return Boolean(navigator.clipboard && navigator.clipboard.writeText)
  } catch {
    return false
  }
}

function setCopyFallbackLabel(section: HTMLElement): void {
  const btn = section.querySelector<HTMLButtonElement>('[data-license-once-copy]')
  if (btn) btn.textContent = hasClipboard() ? 'Copy' : 'Select'
}

// ---------------------------------------------------------------------------
// Live, 30 min rolling bars.
// ---------------------------------------------------------------------------

/**
 * Zero draws nothing. The 2px floor exists so a real but tiny minute (one seat against a busy max)
 * stays visible; applying it to zero as well painted a purple tick for a minute in which nothing
 * happened, so a fleet with no live seats showed a row of coloured marks under the number 0 -- the
 * chart contradicting the tile beside it. Below zero cannot happen, and is treated as zero.
 */
function barHeight(value: number, max: number): number {
  if (value <= 0) return 0
  return Math.max(2, Math.round((value / Math.max(1, max)) * (LIVE30_H - 4)))
}

function setBarHeight(g: SVGGElement, value: number, max: number): void {
  g.dataset.value = String(value)
  const rect = g.querySelector('rect')
  if (!rect) return
  const bh = barHeight(value, max)
  rect.setAttribute('y', String(LIVE30_H - bh))
  rect.setAttribute('height', String(bh))
}

function readTranslateX(g: SVGGElement): number {
  const style = (g as unknown as HTMLElement).style.transform
  const match = /translateX\(([-\d.]+)px\)/.exec(style)
  return match ? Number(match[1]) : 0
}

function appendLiveBar(svg: SVGSVGElement, value: number, index: number, max: number): SVGGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const g = document.createElementNS(ns, 'g') as unknown as SVGGElement
  g.setAttribute('class', 'ov-bar-slot')
  ;(g as unknown as HTMLElement).style.transform = `translateX(${index * LIVE30_STEP}px)`
  const rect = document.createElementNS(ns, 'rect')
  rect.setAttribute('x', '0')
  rect.setAttribute('width', String(LIVE30_BAR_W))
  rect.setAttribute('rx', '1')
  rect.setAttribute('fill', 'var(--data-1)')
  g.appendChild(rect)
  svg.appendChild(g)
  setBarHeight(g, value, max)
  return g
}

/** Seeds the first bar from the already-rendered tile number (never a fetch, never a fabricated
 *  value): `data` is only present on a rerender, so at boot this reads the real server-rendered
 *  text back out of the DOM instead. */
function seedLiveBarsIfEmpty(section: HTMLElement, data: DashboardPayload | null): void {
  const svg = section.querySelector<SVGSVGElement>('[data-ov-live30-svg]')
  if (!svg || svg.querySelector('.ov-bar-slot')) return
  const fromData = data ? data.roi.seats30m : NaN
  const seed = Number.isFinite(fromData)
    ? fromData
    : Number(section.querySelector('[data-flash-key="tile-live30"]')?.textContent || '')
  if (Number.isFinite(seed)) appendLiveBar(svg, seed, 0, Math.max(1, seed))
}

/** One sample per real minute while this page stays open, from the live snapshot's own
 *  `seats30m` (plan 3.5b: "the newest minute bar slides in from the right, the oldest slides
 *  out"). A sample landing in the same minute as the last one updates that bar's height instead
 *  of adding a new one, so the strip only ever grows once a minute actually elapses. */
function pushLiveSample(section: HTMLElement, value: number): void {
  const svg = section.querySelector<SVGSVGElement>('[data-ov-live30-svg]')
  if (!svg) return
  const minuteKey = String(Math.floor(Date.now() / 60000))
  let groups = Array.from(svg.querySelectorAll<SVGGElement>('.ov-bar-slot'))
  if (svg.dataset.lastMinute === minuteKey && groups.length) {
    const last = groups[groups.length - 1]
    const max = Math.max(1, value, ...groups.slice(0, -1).map((g) => Number(g.dataset.value || 0)))
    setBarHeight(last, value, max)
    return
  }
  svg.dataset.lastMinute = minuteKey
  groups.forEach((g) => {
    ;(g as unknown as HTMLElement).style.transform = `translateX(${readTranslateX(g) - LIVE30_STEP}px)`
  })
  if (groups.length >= LIVE30_SLOTS) {
    const oldest = groups[0]
    oldest.classList.add('ov-bar-exit')
    setTimeout(() => oldest.remove(), 280)
    groups = groups.slice(1)
  }
  const max = Math.max(1, value, ...groups.map((g) => Number(g.dataset.value || 0)))
  groups.forEach((g) => setBarHeight(g, Number(g.dataset.value || 0), max))
  const added = appendLiveBar(svg, value, groups.length, max)
  slideIn(added as unknown as HTMLElement, 'right')
}

// ---------------------------------------------------------------------------
// metis:live -- tile flashes + the rolling bars.
// ---------------------------------------------------------------------------

function updateTileNumber(section: HTMLElement, flashKey: string, value: number): void {
  const el = section.querySelector<HTMLElement>(`[data-flash-key="${flashKey}"]`)
  if (!el) return
  const next = String(value)
  if (el.textContent !== next) {
    el.textContent = next
    flash(el)
  }
}

interface LiveDetail {
  liveSeats?: number
  seats30m?: number
}

function handleLive(section: HTMLElement, detail: LiveDetail | undefined): void {
  if (!detail) return
  if (typeof detail.liveSeats === 'number') updateTileNumber(section, 'tile-live', detail.liveSeats)
  if (typeof detail.seats30m === 'number') {
    updateTileNumber(section, 'tile-live30', detail.seats30m)
    pushLiveSample(section, detail.seats30m)
  }
}

// ---------------------------------------------------------------------------
// Connectors card (plan 6.2: the compact 6.10b list block next to Countries). DashboardPayload
// carries no connector rows (see operator/src/render/pages/overview.ts's block comment), so this
// fetches the same GET /v1/admin/integrations route operator/client/pages/connectors.ts already
// uses and renders it through that page's exported, pure renderConnectorsCardRows() -- the same
// function overview.test.ts exercises with fixture rows, so the client and the test render
// byte-identical markup from the wire shape that route returns (plan D2).
// ---------------------------------------------------------------------------

function toOverviewConnectorSummaries(rows: ConnectorSummary[]): OverviewConnectorSummary[] {
  return rows
    .filter((r) => r.status === 'active')
    .map((r): OverviewConnectorSummary => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      transport: r.transport === 'mcp' ? 'mcp' : 'rest',
      healthy: r.health === 'connected',
      reason:
        r.health === 'failing'
          ? (r.lastTest && (r.lastTest.error?.message || r.lastTest.summary)) || 'Connection test failed.'
          : r.health === 'untested'
            ? 'Not tested yet.'
            : undefined,
      toolsCount: r.tools?.length
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

// Exported (only) so operator/client/pages/overview.test.ts can drive this async, DOM-mutating
// loader directly against a mocked api() without going through the rest of initOverview()'s
// side effects -- no other module imports this.
export async function loadConnectorsCard(section: HTMLElement): Promise<void> {
  const root = section.querySelector<HTMLElement>('[data-ov-connectors-root]')
  const errorEl = section.querySelector<HTMLElement>('[data-ov-connectors-error]')
  if (!root) return
  if (errorEl) errorEl.hidden = true
  if (!hasBackend()) {
    // No Worker is behind /v1/admin/integrations in a standalone preview (see api.ts's
    // `hasBackend`) -- an honest "offline preview" card state instead of the raw "network
    // failed" a doomed fetch would otherwise surface through errorEl (task report finding 8).
    root.innerHTML = `<article class="card pad-b10 connector-group">${emptyState({
      title: 'Offline preview.',
      description: 'No Worker is answering /v1/admin/integrations here -- connectors load once this page runs against a deployed Worker.'
    })}</article>`
    root.setAttribute('data-ov-connectors-state', 'offline')
    return
  }
  const res = await api('/v1/admin/integrations')
  if (!res || res.ok === false || !Array.isArray(res.integrations)) {
    // The loading skeleton rendered by operator/src/render/pages/overview.ts's
    // renderConnectorsSkeleton() lives inside this same root -- clear it out on failure so the
    // error state below is the only thing shown. Leaving it in place stacked a permanent "Loading
    // connectors" skeleton on top of the error text forever, since nothing else ever removes it.
    root.innerHTML = ''
    root.setAttribute('data-ov-connectors-state', 'error')
    if (errorEl) {
      errorEl.hidden = false
      errorEl.textContent = (res && res.error) || 'Could not load connectors. Reopen this page to retry.'
    }
    return
  }
  const rows = toOverviewConnectorSummaries(res.integrations as ConnectorSummary[])
  root.innerHTML = renderConnectorsCardRows(rows)
  root.setAttribute('data-ov-connectors-state', 'ready')
  bindMotion(root)
}

function openConnectorsPage(): void {
  location.hash = 'connectors'
}

// ---------------------------------------------------------------------------
// Range / granularity (honest about the data-gap: see operator/src/render/pages/overview.ts).
// ---------------------------------------------------------------------------

function setActiveSegment(wrap: HTMLElement, btn: HTMLElement): void {
  wrap.querySelectorAll<HTMLElement>('[data-segmented]').forEach((b) => {
    const active = b === btn
    b.classList.toggle('on', active)
    b.setAttribute('aria-checked', active ? 'true' : 'false')
  })
}

function applyRangeChoice(id: string): void {
  try {
    const url = new URL(location.href)
    url.searchParams.set('range', id)
    history.replaceState(null, '', url.toString())
  } catch {
    /* URL/history unavailable (non-browser test context): the visual toggle above still ran. */
  }
  if (id !== '7d') {
    toast({
      kind: 'info',
      text: 'Showing the last 7 days. The dashboard route does not filter by range yet; your choice is saved in the link.'
    })
  }
}

function applyRangeFromUrl(section: HTMLElement): void {
  try {
    const range = new URL(location.href).searchParams.get('range')
    if (!range) return
    const wrap = section.querySelector<HTMLElement>('[data-ov-range]')
    const btn = wrap?.querySelector<HTMLElement>(`[data-segmented="${range}"]`)
    if (wrap && btn) setActiveSegment(wrap, btn)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Tab switching (the six cards).
// ---------------------------------------------------------------------------

function switchTab(section: HTMLElement, groupId: string, paneId: string): void {
  const target = `${groupId}:${paneId}`
  section.querySelectorAll<HTMLElement>(`[data-ov-tlc-tab^="${groupId}:"]`).forEach((btn) => {
    const active = btn.getAttribute('data-ov-tlc-tab') === target
    btn.classList.toggle('on', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  section.querySelectorAll<HTMLElement>(`[data-ov-tlc-pane^="${groupId}:"]`).forEach((pane) => {
    pane.hidden = pane.getAttribute('data-ov-tlc-pane') !== target
  })
}

// ---------------------------------------------------------------------------
// Search + Filters.
// ---------------------------------------------------------------------------

function applyFilters(section: HTMLElement): void {
  const globalQuery = (section.querySelector<HTMLInputElement>('[data-ov-search]')?.value || '').trim().toLowerCase()
  const localQueries = new Map<string, string>()
  section.querySelectorAll<HTMLInputElement>('[data-ov-tlc-search]').forEach((input) => {
    localQueries.set(input.dataset.ovTlcSearch || '', input.value.trim().toLowerCase())
  })
  const activeFacets = new Map<string, Set<string>>()
  section.querySelectorAll<HTMLInputElement>('[data-ov-filter-input]:checked').forEach((cb) => {
    const facet = cb.dataset.ovFilterFacet || ''
    if (!activeFacets.has(facet)) activeFacets.set(facet, new Set())
    activeFacets.get(facet)?.add(cb.value)
  })
  section.querySelectorAll<HTMLElement>('[data-ov-tlc-pane] .tlc-row[data-q]').forEach((row) => {
    const q = row.getAttribute('data-q') || ''
    const groupId = (row.closest<HTMLElement>('[data-ov-tlc-pane]')?.dataset.ovTlcPane || '').split(':')[0]
    const localQuery = localQueries.get(groupId) || ''
    let visible = (!globalQuery || q.includes(globalQuery)) && (!localQuery || q.includes(localQuery))
    if (visible) {
      for (const [facet, values] of activeFacets) {
        if (!values.size) continue
        const attr = row.getAttribute(`data-${facet}`)
        if (attr != null && !values.has(attr)) {
          visible = false
          break
        }
      }
    }
    row.hidden = !visible
  })
}

function toggleFiltersMenu(section: HTMLElement, force?: boolean): void {
  const toggle = section.querySelector<HTMLElement>('[data-ov-filters-toggle]')
  const menu = section.querySelector<HTMLElement>('[data-ov-filter-menu]')
  if (!toggle || !menu) return
  const next = force ?? menu.hidden
  menu.hidden = !next
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false')
}

function closeFiltersOnOutsideClick(section: HTMLElement, e: Event): void {
  const menu = section.querySelector<HTMLElement>('[data-ov-filter-menu]')
  if (!menu || menu.hidden) return
  const target = e.target as Node | null
  if (target && section.querySelector('.ov-filters-wrap')?.contains(target)) return
  toggleFiltersMenu(section, false)
}

// ---------------------------------------------------------------------------
// Generate license (scoped to this section only -- see the file header for why this does not
// call operator/client/licenses.ts's shared, unscoped initLicenseActions()).
// ---------------------------------------------------------------------------

async function handleGenerate(form: HTMLFormElement): Promise<void> {
  const fd = new FormData(form)
  const j = await api('/v1/admin/licenses/generate', { days: Number(fd.get('days')) })
  const root = form.parentElement
  const box = root?.querySelector<HTMLElement>('[data-license-once]')
  const input = root?.querySelector<HTMLInputElement>('[data-license-once-value]')
  if (j && j.ok && j.license && box && input) {
    input.value = j.license
    box.hidden = false
    toast({ kind: 'ok', text: 'License generated. Copy it now, it will not be shown again.' })
  } else {
    toast({ kind: 'error', text: (j && j.error) || 'Could not generate a license.' })
  }
}

function handleCopyOrSelect(btn: HTMLElement): void {
  const box = btn.closest<HTMLElement>('[data-license-once]')
  const input = box?.querySelector<HTMLInputElement>('[data-license-once-value]')
  if (!input) return
  if (hasClipboard()) {
    navigator.clipboard.writeText(input.value).catch(() => {
      input.select()
    })
  } else {
    input.select()
  }
}

// ---------------------------------------------------------------------------
// Delegated event handlers.
// ---------------------------------------------------------------------------

function handleClick(section: HTMLElement, e: Event): void {
  const target = e.target as HTMLElement | null
  if (!target) return

  const rangeWrap = target.closest<HTMLElement>('[data-ov-range]')
  const segBtn = target.closest<HTMLElement>('[data-segmented]')
  if (rangeWrap && segBtn) {
    setActiveSegment(rangeWrap, segBtn)
    applyRangeChoice(segBtn.dataset.segmented || '7d')
    return
  }

  const granWrap = target.closest<HTMLElement>('[data-ov-granularity]')
  if (granWrap && segBtn) {
    setActiveSegment(granWrap, segBtn)
    if (segBtn.dataset.segmented === 'hour') {
      toast({ kind: 'info', text: 'Hourly granularity is not available for unique seats yet. Showing daily buckets.' })
    }
    return
  }

  const filtersToggle = target.closest('[data-ov-filters-toggle]')
  if (filtersToggle) {
    toggleFiltersMenu(section)
    return
  }

  const filterClear = target.closest('[data-ov-filter-clear]')
  if (filterClear) {
    section.querySelectorAll<HTMLInputElement>('[data-ov-filter-input]').forEach((cb) => {
      cb.checked = false
    })
    applyFilters(section)
    return
  }

  const tlcTab = target.closest<HTMLElement>('[data-ov-tlc-tab]')
  if (tlcTab) {
    const [groupId, paneId] = (tlcTab.dataset.ovTlcTab || '').split(':')
    if (groupId && paneId) switchTab(section, groupId, paneId)
    return
  }

  const copyBtn = target.closest<HTMLElement>('[data-license-once-copy]')
  if (copyBtn) {
    handleCopyOrSelect(copyBtn)
    return
  }

  // The compact Connectors card never opens the full connection drawer itself (that flow lives on
  // #connectors); every row takes the seat straight to the full page, same as its own "Show N
  // more" links already do.
  const connectorsCardRow = target.closest<HTMLElement>('[data-ov-connectors-card] .connector-row')
  if (connectorsCardRow) {
    openConnectorsPage()
    return
  }
}

function handleKeydown(section: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  const row = target.closest<HTMLElement>('[data-ov-connectors-card] .connector-row')
  if (row && target === row) {
    e.preventDefault()
    openConnectorsPage()
  }
}

function handleInput(section: HTMLElement, e: Event): void {
  const target = e.target as HTMLElement | null
  if (!target) return
  if (target.matches('[data-ov-search], [data-ov-tlc-search], [data-ov-filter-input]')) {
    applyFilters(section)
  }
}

function handleSubmit(section: HTMLElement, e: Event): void {
  const target = e.target as HTMLElement | null
  const form = target?.closest<HTMLFormElement>('[data-license-generate]')
  if (!form || !section.contains(form)) return
  e.preventDefault()
  void handleGenerate(form)
}
