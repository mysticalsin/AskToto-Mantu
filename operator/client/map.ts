/**
 * Shoey world map paint. World land is inlined in the server-rendered `#map-root` HTML as
 * `path[data-iso]`; `paintShoeyMap` only restyles it for the current theme. `ensureShoeyLand`
 * is a last-resort rebuild for the rare case the markup did not ship with land paths.
 *
 * `SHOEY_LAND_SVG` is baked in at build time: operator/scripts/build-client.mjs imports
 * operator/src/charts.ts in Node, evaluates it, and inlines the resulting SVG string via an
 * esbuild `define`, so the browser never has to compute or fetch it.
 */

declare const __SHOEY_LAND_SVG__: string
const SHOEY_LAND_SVG = __SHOEY_LAND_SVG__

export function ensureShoeyLand(root: HTMLElement): void {
  if (root.querySelector('path[data-iso]')) return
  var box = document.createElement('div')
  box.innerHTML = SHOEY_LAND_SVG
  var fresh = box.querySelector('svg.shoey-world')
  if (!fresh) return
  var old = root.querySelector('svg.world')
  if (old && old.querySelectorAll) {
    old.querySelectorAll('circle.seat-dot, circle.dot, g.pill-g').forEach(function (n) {
      fresh!.appendChild(n)
    })
  }
  if (old && typeof (old as any).replaceWith === 'function') {
    ;(old as any).replaceWith(fresh)
  } else if (old && old.parentNode && old.parentNode.replaceChild) {
    old.parentNode.replaceChild(fresh, old)
  } else {
    root.insertBefore(fresh, root.firstChild)
  }
}

export function paintShoeyMap(): void {
  var root = document.getElementById('map-root')
  if (!root) return
  ensureShoeyLand(root)
  var dark = document.documentElement.getAttribute('data-theme') === 'dark'
  var land = dark ? '#3f3f46' : '#E5E7EB'
  var ocean = dark ? '#0a0a0b' : '#FFFFFF'
  var stroke = dark ? '#111827' : '#6B7280'
  root.querySelectorAll<HTMLElement>('.world-ocean').forEach(function (r) {
    r.setAttribute('fill', ocean)
  })
  root.querySelectorAll<HTMLElement>('path[data-iso]').forEach(function (p) {
    p.setAttribute('fill', land)
    p.setAttribute('stroke', stroke)
    p.setAttribute('stroke-width', '1.15')
    p.setAttribute('class', ((p.getAttribute('class') || '') + ' world-land').trim())
  })
  var svg = root.querySelector('svg.shoey-world')
  if (svg) svg.setAttribute('data-land', '#E5E7EB')
}

/** Country click on the map filters the geo table. */
export function initGeoCountryFilter(): void {
  document.querySelectorAll<HTMLElement>('#map-root path[data-iso]').forEach(function (p) {
    p.addEventListener('click', function () {
      var iso = p.getAttribute('data-iso')
      document.querySelectorAll<HTMLElement>('[data-vol-pane="geo:geo"] .vol-row[data-q]').forEach(function (row) {
        row.hidden = Boolean(iso) && !(row.getAttribute('data-q') || '').toUpperCase().includes(iso || '')
      })
    })
  })
}
