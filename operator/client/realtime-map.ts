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

/** Theme restyle for realtime ocean/land/grid/labels without swapping SVG. */
export function paintRealtimeMapTheme(): void {
  var root = document.getElementById('map-root')
  if (!root) return
  if (!root.querySelector('svg.rt-map-svg')) return
  var mapThemeAttr = root.getAttribute('data-map-theme') || ''
  var docTheme = document.documentElement.getAttribute('data-theme')
  var prefersDark =
    !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches
  var dark = true
  if (docTheme === 'light' || mapThemeAttr === 'light') dark = false
  else if (docTheme === 'dark' || mapThemeAttr === 'dark') dark = true
  else dark = prefersDark // system / unset: follow OS, default dark when unknown
  var land = dark ? '#1f1830' : 'rgb(240,240,240)'
  var stroke = dark ? '#3a2f52' : 'rgb(153,153,153)'
  var ocean = dark ? '#120e1c' : '#ffffff'
  var grid = dark ? 'rgba(37, 29, 54, 0.85)' : 'rgba(23, 8, 38, 0.08)'
  var label = dark ? '#f3eefb' : '#170826'
  var pillBg = dark ? 'rgba(26, 21, 38, 0.92)' : 'rgba(255,255,255,0.92)'
  var pillBorder = dark ? 'rgba(255,255,255,0.14)' : 'rgba(23, 8, 38, 0.12)'
  var pillFg = dark ? '#fafafa' : '#170826'
  root.querySelectorAll<SVGRectElement>('rect.world-ocean').forEach(function (r) {
    r.setAttribute('fill', ocean)
  })
  root.querySelectorAll<SVGLineElement>('line.rt-map-grid').forEach(function (l) {
    l.setAttribute('stroke', grid)
  })
  root.querySelectorAll<SVGPathElement>('path.world-land').forEach(function (p) {
    p.setAttribute('fill', land)
    p.setAttribute('stroke', stroke)
  })
  root.querySelectorAll<SVGTextElement>('text.rt-pin-label').forEach(function (t) {
    t.setAttribute('fill', label)
  })
  root.querySelectorAll<HTMLElement>('.rt-country-pill').forEach(function (el) {
    el.style.background = pillBg
    el.style.borderColor = pillBorder
    el.style.color = pillFg
  })
  var svg = root.querySelector('svg.rt-map-svg')
  if (svg) svg.setAttribute('data-map-theme', dark ? 'dark' : 'light')
}
