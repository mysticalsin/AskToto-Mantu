/**
 * Hash router. Keeps `#id` in the URL in sync with the visible `[data-page]` panel, the `on`
 * class on the matching `[data-nav]` link, and which of the rail's three primary-action
 * variants is visible. `route` is exposed as `window.route` so pages and tests can drive
 * navigation directly.
 */
import { paintShoeyMap } from './map'
import { applyEventsFilter } from './filters'

/** Mirrors operator/src/render/shell.ts's `railActionFor()` exactly (plan P0.4: "the rail shows
 * the right ... primary action"). First paint can only ever render the 'overview' variant set
 * visible (a URL fragment never reaches the Worker), so this runs on every route change to fix
 * it up for the actual page, including the very first one. */
function railActionFor(page: string): 'generate' | 'connector' | 'search' {
  if (page === 'overview' || page === 'licenses') return 'generate'
  if (page === 'connectors') return 'connector'
  return 'search'
}

export const titles: Record<string, string> = {
  overview: 'Overview',
  realtime: 'Realtime',
  events: 'Events',
  sessions: 'Sessions',
  licenses: 'Licenses',
  groups: 'Groups',
  notifications: 'Notifications',
  keys: 'Keys',
  connectors: 'Connectors',
  audit: 'Audit',
  settings: 'Settings',
  map: 'Realtime'
}

export function route(to?: string): void {
  if (typeof to === 'string') {
    var next = to
    if (next.charAt(0) === '#') next = next.slice(1)
    if (next.charAt(0) === '/') next = next.slice(1)
    if (!next) next = 'overview'
    if (titles[next] || next === 'map') {
      var want = '#' + next
      if (location.hash !== want) location.hash = want
    }
  }
  var raw = (location.hash || '#overview').replace('#', '')
  var requested = titles[raw] ? raw : 'overview'
  var id = requested === 'map' ? 'realtime' : requested
  document.querySelectorAll<HTMLElement>('[data-page]').forEach(function (p) {
    p.hidden = p.getAttribute('data-page') !== id
  })
  var navOn = requested === 'map' ? 'realtime' : requested
  document.querySelectorAll<HTMLElement>('[data-nav]').forEach(function (a) {
    a.classList.toggle('on', a.getAttribute('data-nav') === navOn)
  })
  var wantAction = railActionFor(navOn)
  document.querySelectorAll<HTMLElement>('[data-rail-action]').forEach(function (el) {
    el.hidden = el.getAttribute('data-rail-action') !== wantAction
  })
  var t = document.getElementById('page-title')
  if (t) t.textContent = titles[id]
  if (id === 'realtime') paintShoeyMap()
  if (id === 'events') applyEventsFilter()
}

/** Wires the hash router: initial pathname-to-hash redirect, hashchange listener, first route. */
export function initRouter(): void {
  ;(window as any).route = route
  window.addEventListener('hashchange', function () {
    route()
  })
  if (!location.hash) {
    var path = location.pathname.replace(/^\//, '')
    if (path && titles[path]) location.hash = '#' + path
  }
  route()
}
