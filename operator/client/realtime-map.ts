/**
 * Realtime page client (operator UX plan, Rock 1). The SSR page (src/render/pages/realtime.ts)
 * ships the map, feed and tables plus `data-rt-state` (the same place rows live.json carries).
 * This module:
 *  - wires zoom/pan (src/world/map-dom.ts) and re-clusters the pill layer when the zoom bucket
 *    changes, so a multi-country pill splits into city pills as you zoom in;
 *  - listens to `metis:live` (operator/client/live.ts is the ONLY poller) and swaps the pin,
 *    cluster, KPI, feed and table layers in place, never re-rendering the section;
 *  - opens the cluster popover next to a clicked pill (Escape / close / outside click closes it
 *    and returns focus to the pill).
 * Colour is CSS tokens only: there is no theme repaint step any more.
 */
import type { LiveSnapshot } from '../src/dashboard'
import type { PlaceActivity, RealtimePlace } from '../src/realtime-geo'
import { realtimeSeatTotal, rtFeedRows, rtLocationTable, rtModeTable } from '../src/render/pages/realtime'
import {
  clusterPlaces,
  clusterPopoverHtml,
  placeToPoint,
  renderClusterLayer,
  renderPinLayer,
  zoomBucket,
  type Cluster,
  type PopoverSession,
  type RealtimeMapPoint
} from '../src/world/map'
import { attachMapInteraction, type MapInteractionHandle } from '../src/world/map-dom'
import { MAP_DIMENSIONS } from '../src/world/mercator'

interface RtState {
  now: number
  places: RealtimePlace[]
  placeActivity: Record<string, PlaceActivity>
  sessions: PopoverSession[]
}

var state: RtState = { now: Date.now(), places: [], placeActivity: {}, sessions: [] }
var points: RealtimeMapPoint[] = []
var handle: MapInteractionHandle | null = null
var bucket = 1
var tooltipEl: HTMLDivElement | null = null
var openPill: HTMLElement | null = null
var liveBound = false
/** Last applied live.json generation: an unchanged payload never touches the DOM, so an open
 *  popover or a pill under the pointer survives every 5 s poll. */
var lastGeneration: number | null = null

function stage(): HTMLElement | null {
  return document.querySelector<HTMLElement>('section[data-page="realtime"] [data-rt-stage]')
}

function readSsrState(el: HTMLElement): void {
  var raw = el.getAttribute('data-rt-state')
  if (!raw) return
  try {
    var parsed = JSON.parse(raw) as { now: number; places: RealtimePlace[]; placeActivity: Record<string, PlaceActivity> }
    state = { now: parsed.now, places: parsed.places || [], placeActivity: parsed.placeActivity || {}, sessions: state.sessions }
    points = state.places.map(placeToPoint)
  } catch (e) {
    // Malformed state: keep the SSR layers as rendered; the first live poll replaces them.
  }
}

function currentK(): number {
  return handle ? handle.zoom() : 1
}

function swapLayer(selector: string, html: string): void {
  var root = stage()
  var old = root && root.querySelector(selector)
  if (!old || !old.parentNode) return
  // Parse inside an <svg> so the new <g> lands in the SVG namespace.
  var holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  holder.innerHTML = html
  var fresh = holder.firstElementChild
  if (fresh) old.parentNode.replaceChild(fresh, old)
}

function paintMapLayers(): void {
  var k = currentK()
  swapLayer('[data-pin-layer]', renderPinLayer(points))
  swapLayer('[data-cluster-layer]', renderClusterLayer(points, k))
  var empty = stage()?.querySelector<HTMLElement>('[data-map-empty]')
  if (empty) empty.hidden = points.length > 0
  if (handle) handle.refresh()
  bindPins()
}

function paintPanels(snapshot: { recentEvents?: LiveSnapshot['recentEvents']; now: number }): void {
  var root = stage()
  if (!root) return
  var seats = root.querySelector<HTMLElement>('[data-rt-seats]')
  if (seats) seats.textContent = String(realtimeSeatTotal(state.places))
  var feed = root.querySelector<HTMLElement>('[data-rt-feed]')
  if (feed && snapshot.recentEvents) feed.innerHTML = rtFeedRows(snapshot.recentEvents, snapshot.now)
  var section = root.closest('section[data-page="realtime"]')
  if (!section) return
  ;(['country', 'region', 'city'] as const).forEach(function (grain) {
    var pane = section!.querySelector<HTMLElement>('[data-rt-loc-pane="' + grain + '"]')
    if (pane) pane.innerHTML = rtLocationTable(state.places, grain)
  })
  var modes = section.querySelector<HTMLElement>('[data-rt-modes-body]')
  if (modes) modes.innerHTML = rtModeTable(state.placeActivity)
}

function onLive(ev: Event): void {
  var snapshot = (ev as CustomEvent<LiveSnapshot>).detail
  if (!snapshot || !snapshot.geo || !Array.isArray(snapshot.geo.places)) return
  if (lastGeneration !== null && snapshot.generation === lastGeneration) return
  lastGeneration = snapshot.generation
  state = {
    now: snapshot.now,
    places: snapshot.geo.places,
    placeActivity: snapshot.placeActivity || {},
    sessions: (snapshot.liveSeatsTable || []).map(function (s) {
      return { hostname: s.hostname, email: s.email, city: s.city, country: s.country, lastSeen: s.sessionStarted }
    })
  }
  points = state.places.map(placeToPoint)
  if (!stage()) return
  closePopover(false)
  paintMapLayers()
  paintPanels(snapshot)
}

// ---- Tooltip -----------------------------------------------------------------------------

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl
  tooltipEl = document.createElement('div')
  tooltipEl.className = 'rt-map-tooltip'
  tooltipEl.setAttribute('role', 'tooltip')
  tooltipEl.hidden = true
  document.body.appendChild(tooltipEl)
  return tooltipEl
}

function bindPins(): void {
  var root = stage()
  if (!root) return
  root.querySelectorAll<HTMLElement>('[data-pin-layer] [data-pin]').forEach(function (pin) {
    if (pin.getAttribute('data-bound') === '1') return
    pin.setAttribute('data-bound', '1')
    pin.addEventListener('mousemove', function (ev) {
      var tip = ensureTooltip()
      var city = pin.getAttribute('data-city') || ''
      var country = pin.getAttribute('data-country') || ''
      var seats = pin.getAttribute('data-seats') || '0'
      var where = city && city !== country ? city + ', ' + country : country
      tip.textContent = where + ' · ' + seats + (seats === '1' ? ' seat' : ' seats')
      tip.hidden = false
      tip.style.left = Math.round((ev as MouseEvent).clientX + 12) + 'px'
      tip.style.top = Math.round((ev as MouseEvent).clientY + 12) + 'px'
    })
    var hide = function (): void {
      if (tooltipEl) tooltipEl.hidden = true
    }
    pin.addEventListener('mouseleave', hide)
    pin.addEventListener('blur', hide)
  })
}

// ---- Popover -----------------------------------------------------------------------------

function popoverEl(): HTMLElement | null {
  var host = stage()?.querySelector<HTMLElement>('[data-rt-popover-host]')
  if (!host) return null
  var pop = host.querySelector<HTMLElement>('[data-rt-popover]')
  if (!pop) {
    pop = document.createElement('div')
    pop.className = 'rt-popover'
    pop.setAttribute('data-rt-popover', '')
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-modal', 'false')
    pop.hidden = true
    host.appendChild(pop)
  }
  return pop
}

function topPairs(rows: [string, number][][], n: number): [string, number][] {
  var totals = new Map<string, number>()
  rows.forEach(function (list) {
    list.forEach(function (pair) {
      totals.set(pair[0], (totals.get(pair[0]) || 0) + pair[1])
    })
  })
  return [...totals.entries()].sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]) }).slice(0, n)
}

function popoverFor(cluster: Cluster): string {
  var keys = cluster.members.map(function (m) { return m.key || '' })
  var activity = keys.map(function (k) { return state.placeActivity[k] }).filter(Boolean) as PlaceActivity[]
  var where = new Set(cluster.members.map(function (m) { return (m.country || '').toUpperCase() + '|' + (m.city || '') }))
  var sessions = state.sessions.filter(function (s) {
    return where.has((s.country || '').toUpperCase() + '|' + (s.city || ''))
  }).slice(0, 6)
  return clusterPopoverHtml(cluster, {
    modes: topPairs(activity.map(function (a) { return a.modes }), 5),
    skills: topPairs(activity.map(function (a) { return a.skills }), 5),
    sessions: sessions,
    now: state.now
  })
}

function closePopover(returnFocus: boolean): void {
  var pop = popoverEl()
  if (pop && !pop.hidden) {
    pop.hidden = true
    pop.innerHTML = ''
  }
  if (returnFocus && openPill && document.body.contains(openPill)) openPill.focus()
  openPill = null
}

function openPopover(pill: HTMLElement): void {
  var index = Number(pill.getAttribute('data-cluster-pill'))
  var clusters = clusterPlaces(points, currentK())
  var cluster = clusters[index]
  var pop = popoverEl()
  var root = stage()
  if (!cluster || !pop || !root) return
  pop.innerHTML = popoverFor(cluster)
  pop.hidden = false
  var rootBox = root.getBoundingClientRect()
  var pillBox = pill.getBoundingClientRect()
  var left = Math.min(Math.max(8, pillBox.left - rootBox.left), Math.max(8, rootBox.width - 392))
  var top = pillBox.bottom - rootBox.top + 8
  pop.style.left = Math.round(left) + 'px'
  pop.style.top = Math.round(top) + 'px'
  openPill = pill
  var close = pop.querySelector<HTMLElement>('[data-rt-popover-close]')
  if (close) {
    close.addEventListener('click', function () { closePopover(true) })
    close.focus()
  }
}

// ---- Wiring ------------------------------------------------------------------------------

function bindLocationTabs(section: Element): void {
  section.querySelectorAll<HTMLElement>('[data-rt-loc-tabs] [data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var id = tab.getAttribute('data-tab')
      section.querySelectorAll<HTMLElement>('[data-rt-loc-tabs] [data-tab]').forEach(function (t) {
        var on = t === tab
        t.classList.toggle('on', on)
        t.setAttribute('aria-selected', on ? 'true' : 'false')
      })
      section.querySelectorAll<HTMLElement>('[data-rt-loc-pane]').forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-rt-loc-pane') !== id
      })
    })
  })
}

/** Bind the Realtime page. Safe to call after every route change or section re-render. */
export function initRealtimeMap(): void {
  var root = stage()
  if (!root) return
  readSsrState(root)
  lastGeneration = null
  var mapRoot = root.querySelector('[data-map-root]')
  if (handle) {
    handle.destroy()
    handle = null
  }
  bucket = 1
  if (mapRoot) {
    handle = attachMapInteraction(mapRoot, {
      width: MAP_DIMENSIONS['1152'].width,
      height: MAP_DIMENSIONS['1152'].height,
      minZoom: 1,
      maxZoom: 8,
      onZoom: function (k) {
        var next = zoomBucket(k)
        if (next === bucket) return
        bucket = next
        closePopover(false)
        swapLayer('[data-cluster-layer]', renderClusterLayer(points, k))
        if (handle) handle.refresh()
      }
    })
  }
  bindPins()
  if (!liveBound) {
    liveBound = true
    window.addEventListener('metis:live', onLive)
  }
  // The router and reinitPage can both call this for the same stage: bind stage listeners once.
  if (root.getAttribute('data-rt-bound') === '1') return
  root.setAttribute('data-rt-bound', '1')
  var section = root.closest('section[data-page="realtime"]')
  if (section) bindLocationTabs(section)
  root.addEventListener('click', function (ev) {
    var target = ev.target as Element | null
    var pill = target && target.closest ? target.closest<HTMLElement>('[data-cluster-pill]') : null
    if (pill) {
      ev.stopPropagation()
      if (openPill === pill) closePopover(true)
      else openPopover(pill)
      return
    }
    var pop = popoverEl()
    if (pop && !pop.hidden && target && !pop.contains(target)) closePopover(false)
  })
  root.addEventListener('keydown', function (ev) {
    if ((ev as KeyboardEvent).key === 'Escape' && openPill) {
      ev.preventDefault()
      closePopover(true)
    }
  })
}
