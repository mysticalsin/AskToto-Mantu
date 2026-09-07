/**
 * Métis Operator SPA entry point. Bundled by operator/scripts/build-client.mjs into
 * operator/src/spa/client.generated.ts (CONSOLE_JS), served hashed at
 * /assets/operator-<hash>.js and aliased at /assets/index.js. No framework, no dependencies.
 */
import type { DashboardPayload } from '../src/dashboard'
import { esc } from '../src/render'
import { renderAudit } from '../src/render/pages/audit'
import { renderConnectors } from '../src/render/pages/connectors'
import { renderEvents } from '../src/render/pages/events'
import { renderGroups } from '../src/render/pages/groups'
import { renderKeys } from '../src/render/pages/keys'
import { renderLicenses } from '../src/render/pages/licenses'
import { renderNotifications } from '../src/render/pages/notifications'
import { renderOverview } from '../src/render/pages/overview'
import { renderRealtime } from '../src/render/pages/realtime'
import { renderSessions } from '../src/render/pages/sessions'
import { renderSettings } from '../src/render/pages/settings'
import { api } from './api'
import { initRouter } from './router'
import { initTheme } from './theme'
import { initGeoCountryFilter, paintShoeyMap } from './map'
import {
  initVolumeTabs,
  initVolumeSearch,
  initEventsFilters,
  initEvTabs,
  initNtTabs,
  initSessionsFilter,
  initNtFilter,
  initScaleButtons,
  initCrmFilter
} from './filters'
import { initSeatOverlay, initSkillActions, initCrmRetry, initKeyForms } from './actions'
import { initLicenseActions } from './licenses'
import { initCloudflareConnectResult, initMobileRail, initRailAddConnector, initRailGenerate } from './nav'
import { initSearch } from './search'
import { startLivePolling } from './live'
import { toast } from './toasts'
import { bindMotion } from './motion-bind'
import { PAGE_INIT } from './pages/index'

var PAGES = [
  'overview',
  'realtime',
  'events',
  'sessions',
  'licenses',
  'groups',
  'notifications',
  'keys',
  'connectors',
  'audit',
  'settings'
]

var PAGE_RENDERERS: Record<string, (data: DashboardPayload, ctx: { now: number; theme: 'light' }) => string> = {
  overview: renderOverview,
  realtime: renderRealtime,
  events: renderEvents,
  sessions: renderSessions,
  licenses: renderLicenses,
  groups: renderGroups,
  notifications: renderNotifications,
  keys: renderKeys,
  connectors: renderConnectors,
  audit: renderAudit,
  settings: renderSettings
}

/** Re-binds whatever operator/client/*.ts init functions target elements the just-replaced
 * `[data-page="X"]` section owns. Every one of these queries the DOM fresh on each call (none
 * cache a node reference across calls), so calling the relevant subset again after `rerender()`
 * replaces a section's innerHTML re-attaches every listener to the new nodes. Rail-level init
 * (theme, search, mobile nav, live polling) never re-runs here: it never lived inside a
 * `[data-page]` section, so it was never touched by the replacement. */
function reinitPage(page: string): void {
  if (page === 'overview') {
    initVolumeTabs()
    initVolumeSearch()
  }
  if (page === 'realtime') {
    initGeoCountryFilter()
    paintShoeyMap()
  }
  if (page === 'events') {
    initEventsFilters()
    initEvTabs()
  }
  if (page === 'sessions') {
    initSeatOverlay()
    initSessionsFilter()
  }
  if (page === 'licenses') {
    initLicenseActions()
  }
  if (page === 'notifications') {
    initNtTabs()
    initNtFilter()
    initCrmFilter()
    initSkillActions()
    initCrmRetry()
  }
  if (page === 'keys') {
    initKeyForms()
  }
  if (page === 'overview' || page === 'realtime') {
    initScaleButtons()
  }
}

/**
 * Re-fetches `/v1/admin/dashboard` and re-renders one page section in place through its own
 * page module (plan P0.4: never a full document reload). Every mutation handler in operator/client/
 * actions.ts and licenses.ts calls this instead of reloading the whole document; a toast reports
 * the outcome either way.
 */
export async function rerender(page: string): Promise<void> {
  var renderer = PAGE_RENDERERS[page]
  var section = document.querySelector<HTMLElement>('[data-page="' + page + '"]')
  if (!renderer || !section) return
  var data = (await api('/v1/admin/dashboard')) as (DashboardPayload & { ok?: boolean }) | { ok: false; error?: string }
  if (!data || (data as { ok?: boolean }).ok === false) {
    toast({ kind: 'error', text: 'Could not refresh this page. Reopen it to see the latest.' })
    return
  }
  section.innerHTML = renderer(data as DashboardPayload, { now: Date.now(), theme: 'light' })
  reinitPage(page)
  bindMotion(section)
  PAGE_INIT[page]?.(section, data as DashboardPayload)
}

/** The page id the mutation just acted on, so its handler can call `rerender(currentPage())`
 * without hardcoding which page it lives on. */
export function currentPage(): string {
  var raw = (location.hash || '#overview').replace('#', '')
  return PAGES.indexOf(raw) >= 0 ? raw : 'overview'
}

;(function metisOperatorSpa() {
  'use strict'
  ;(self as any).METIS_OPERATOR_SPA = {
    chrome: 'shoey',
    product: 'Métis Operator',
    pages: PAGES,
    nav: PAGES,
    hydrate: 'post-access'
  }

  // Shared render path sanity check: esc() is the same helper the Worker uses for first
  // paint (operator/src/render). Fail loud if the two builds ever disagree on it.
  if (esc('&') !== '&amp;') throw new Error('Métis Operator SPA: shared render path esc() mismatch')

  initRouter()
  initVolumeTabs()
  initVolumeSearch()
  initEventsFilters()
  initEvTabs()
  initNtTabs()
  initSessionsFilter()
  initNtFilter()
  initTheme()
  initSeatOverlay()
  initScaleButtons()
  initGeoCountryFilter()
  initCrmFilter()
  initSkillActions()
  initKeyForms()
  initCrmRetry()
  initLicenseActions()
  initSearch()
  initMobileRail()
  initRailGenerate()
  initRailAddConnector()
  initCloudflareConnectResult()
  startLivePolling()
  bindMotion(document.body)
  // First paint is already server-rendered (no freshly fetched DashboardPayload yet, hence
  // `null`); each page's own init still runs once on its already-rendered `[data-page]` section
  // so it starts interactive rather than only working after a later rerender().
  PAGES.forEach(function (id) {
    var section = document.querySelector<HTMLElement>('[data-page="' + id + '"]')
    if (section) PAGE_INIT[id]?.(section, null)
  })
})()
