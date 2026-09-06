/**
 * Legacy Shoey map compatibility shims. operator/client/main.ts and operator/client/router.ts
 * (files the Realtime task does not own) still import paintShoeyMap() and
 * initGeoCountryFilter() from here on every boot, route change and rerender, so both stay
 * exported. The real, interactive Realtime map (hover fade/tint, wheel/drag/keyboard zoom, the
 * following tooltip, country-click filtering with a spring highlight and a toolbar chip) now
 * lives entirely in operator/client/pages/realtime.ts's initRealtime(), wired through
 * operator/src/world/map-dom.ts's attachMapInteraction() -- the PAGE_INIT hook main.ts already
 * calls on first paint and on every rerender('realtime').
 *
 * World land is inlined in the server-rendered `#map-root` HTML (the legacy `.world.shoey-world`
 * markup some pages still render, distinct from the new `.rt-map`) as `path[data-iso]`;
 * `paintShoeyMap` only restyles it. `ensureShoeyLand` is a last-resort rebuild for the rare case
 * that markup did not ship with land paths.
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
  // Every colour here is a CSS custom property, not a hex literal: operator/src/spa/css.ts's
  // `.world.shoey-world path.world-land, .world.shoey-world path[data-iso]` rule already
  // forces `fill`/`stroke` from `--map-land`/`--map-stroke` with `!important`, so light/dark
  // repaint themselves with zero JS. Setting the same tokens here keeps this element's own
  // attributes honest for anything that reads them directly, without owning any colour value.
  root.querySelectorAll<HTMLElement>('.world-ocean').forEach(function (r) {
    r.setAttribute('fill', 'var(--map-ocean)')
  })
  root.querySelectorAll<HTMLElement>('path[data-iso]').forEach(function (p) {
    p.setAttribute('fill', 'var(--map-land)')
    p.setAttribute('stroke', 'var(--map-stroke)')
    p.setAttribute('stroke-width', '1.15')
    p.setAttribute('class', ((p.getAttribute('class') || '') + ' world-land').trim())
  })
  var svg = root.querySelector('svg.shoey-world')
  if (svg) svg.setAttribute('data-land', 'var(--map-land)')
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
