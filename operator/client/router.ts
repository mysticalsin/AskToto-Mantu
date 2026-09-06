/**
 * Hash router. Keeps `#id` in the URL in sync with the visible `[data-page]` panel and the
 * `on` class on the matching `[data-nav]` link. `route` is exposed as `window.route` so pages
 * and tests can drive navigation directly.
 */
import { paintShoeyMap } from './map'
import { applyEventsFilter } from './filters'

export const titles: Record<string, string> = {
  overview: 'Overview',
  realtime: 'Realtime',
  events: 'Events',
  sessions: 'Sessions',
  notifications: 'Notifications',
  keys: 'Keys',
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
