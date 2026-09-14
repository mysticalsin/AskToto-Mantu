/**
 * Realtime map client wiring. Overview keeps paintShoeyMap for choropleth/shoey-world.
 * Realtime uses renderRealtimeMapSvg (#map-root [data-map-root]) + attachMapInteraction.
 */
import { attachMapInteraction, type MapInteractionHandle } from '../src/world/map-dom'
import { MAP_DIMENSIONS } from '../src/world/mercator'

var handle: MapInteractionHandle | null = null
var tooltipEl: HTMLDivElement | null = null

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'rt-map-tooltip'
  tooltipEl.setAttribute('role', 'tooltip')
  tooltipEl.hidden = true
  document.body.appendChild(tooltipEl)
  return tooltipEl
}

function showPinTooltip(pin: HTMLElement, ev: MouseEvent): void {
  var tip = ensureTooltip()
  var country = pin.getAttribute('data-country') || ''
  var city = pin.getAttribute('data-city') || ''
  var seats = pin.getAttribute('data-seats') || '0'
  var places = city || country
  tip.textContent = country && city && city !== country
    ? country + ' · ' + seats + ' seats · ' + places
    : (city || country) + ' · ' + seats + ' seats'
  tip.hidden = false
  tip.style.left = Math.round(ev.clientX + 12) + 'px'
  tip.style.top = Math.round(ev.clientY + 12) + 'px'
}

function hidePinTooltip(): void {
  if (tooltipEl) tooltipEl.hidden = true
}

/** Bind zoom/pan + pin tooltips for the current Realtime map. Safe to call after each reinit. */
export function initRealtimeMap(): void {
  var root = document.getElementById('map-root')
  if (!root) return
  var mapRoot = root.querySelector('[data-map-root]') || root
  if (handle) {
    handle.destroy()
    handle = null
  }
  handle = attachMapInteraction(mapRoot, {
    width: MAP_DIMENSIONS['1152'].width,
    height: MAP_DIMENSIONS['1152'].height
  })
  root.querySelectorAll<HTMLElement>('[data-pin]').forEach(function (pin) {
    pin.addEventListener('mousemove', function (ev) {
      showPinTooltip(pin, ev as MouseEvent)
    })
    pin.addEventListener('mouseleave', hidePinTooltip)
    pin.addEventListener('blur', hidePinTooltip)
  })
}

/** Theme restyle for realtime land without swapping in shoey-world SVG. */
export function paintRealtimeMapTheme(): void {
  var root = document.getElementById('map-root')
  if (!root) return
  if (!root.querySelector('svg.rt-map-svg')) return
  var dark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') == null &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  var land = dark ? '#2a2a2e' : 'rgb(240,240,240)'
  var stroke = dark ? '#3f3f46' : 'rgb(153,153,153)'
  root.querySelectorAll<SVGPathElement>('path.world-land').forEach(function (p) {
    p.setAttribute('fill', land)
    p.setAttribute('stroke', stroke)
  })
}
