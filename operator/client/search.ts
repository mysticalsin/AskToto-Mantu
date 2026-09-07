/**
 * Rail search field (plan 3.7 item 7, Tony 2026-09-06: "I want a fast search bar for users and
 * licences but not like that" -- no command palette, no page list, no dialog). One plain input;
 * from the first typed character a glass dropdown appears under it with up to four groups (Seats,
 * Licenses, Groups, Connectors), each capped at 8 rows with an "N more" line. Matching is a
 * case-insensitive substring over a client index built from whatever the currently rendered page
 * already has in the DOM -- no fetch. The index is rebuilt on every `metis:live` event (dispatched
 * by operator/client/live.ts) so it does not go stale under a live refresh.
 *
 * `/` focuses the field; arrow keys move the active row; Enter routes to the item's page and
 * clicks its row (opening a drawer where one exists); Escape clears the field and closes the
 * dropdown, or, when the field is empty and not focused, closes an open seat drawer. The `g
 * <letter>` page shortcuts live here too (plan 6.1) -- invisible, no shortcut sheet.
 */
import { avatar } from '../src/render'

type SearchKind = 'seat' | 'license' | 'group' | 'connector'

interface SearchItem {
  kind: SearchKind
  hay: string
  html: string
  hash: string
  target: HTMLElement | null
  /** Seat rows only: filled into `.search-row-title`/`.search-row-sub` as textContent after the
   * row is built, so a hostname or email never has to pass through an HTML-interpolated string. */
  title?: string
  sub?: string
}

const GROUP_LABEL: Record<SearchKind, string> = {
  seat: 'Seats',
  license: 'Licenses',
  group: 'Groups',
  connector: 'Connectors'
}
const GROUP_ORDER: SearchKind[] = ['seat', 'license', 'group', 'connector']
const MAX_PER_GROUP = 8
const DEBOUNCE_MS = 80

/** `g <letter>` chords (plan 6.1). No visible UI; kept in NAV_IDS order. */
const GO_CHORDS: Record<string, string> = {
  o: 'overview',
  r: 'realtime',
  e: 'events',
  s: 'sessions',
  l: 'licenses',
  g: 'groups',
  n: 'notifications',
  k: 'keys',
  c: 'connectors',
  a: 'audit',
  ',': 'settings'
}
const GO_CHORD_TIMEOUT_MS = 900

let inputEl: HTMLInputElement | null = null
let resultsEl: HTMLElement | null = null
let index: SearchItem[] = []
let flat: SearchItem[] = []
let activeIndex = -1
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let awaitingG = false
let awaitingGTimer: ReturnType<typeof setTimeout> | null = null

function isEditableTarget(target: EventTarget | null): boolean {
  var el = target as HTMLElement | null
  if (!el) return false
  var tag = (el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true
}

/** Seat rows already carry a `data-q` haystack built server-side for the Sessions search box
 * (hostname, email, city, country, device, os); reuse it rather than re-deriving one. */
function seatItems(): SearchItem[] {
  var out: SearchItem[] = []
  document.querySelectorAll<HTMLElement>('[data-seat-row]').forEach(function (row) {
    var hostname = row.getAttribute('data-seat-computer') || ''
    var email = row.getAttribute('data-seat-identity') || ''
    var hay = (row.getAttribute('data-q') || (hostname + ' ' + email)).toLowerCase()
    if (!hay) return
    var live = row.getAttribute('data-seat-status-id') === 'live'
    var html =
      avatar({ name: hostname || email || '?', email: email || undefined, live: live }) +
      '<span class="search-row-main"><span class="search-row-title"></span><span class="search-row-sub"></span></span>'
    out.push({
      kind: 'seat',
      hay: hay,
      html: html,
      hash: '#sessions',
      target: row,
      title: hostname || 'Seat',
      sub: email
    })
  })
  return out
}

function licenseItems(): SearchItem[] {
  var out: SearchItem[] = []
  document.querySelectorAll<HTMLElement>('[data-license-last4]').forEach(function (cell) {
    var last4 = cell.getAttribute('data-license-last4') || ''
    if (!last4) return
    var row = cell.closest('tr')
    var status = (row && row.getAttribute('data-license-status')) || ''
    out.push({
      kind: 'license',
      hay: last4.toLowerCase(),
      html:
        '<span class="search-row-mono">··' +
        escapeHtml(last4) +
        '</span><span class="search-row-main"><span class="search-row-title">License</span></span>' +
        (status ? '<span class="search-row-meta">' + escapeHtml(status) + '</span>' : ''),
      hash: '#licenses',
      target: null
    })
  })
  return out
}

/** Groups/Connectors have no rows yet (P1.8/P1.9 have not landed): both pages render an honest
 * empty state today. This queries the attribute contract those page modules are expected to use
 * (`[data-group-row]` with data-group-name/data-group-tier, `[data-connector-row]` with
 * data-connector-label/data-connector-kind) so search "just works" once they ship real rows,
 * without a change here. Until then these always return an empty array -- never a fabricated
 * result. */
function groupItems(): SearchItem[] {
  var out: SearchItem[] = []
  document.querySelectorAll<HTMLElement>('[data-group-row]').forEach(function (row) {
    var name = row.getAttribute('data-group-name') || ''
    var tier = row.getAttribute('data-group-tier') || ''
    if (!name) return
    out.push({
      kind: 'group',
      hay: (name + ' ' + tier).toLowerCase(),
      html:
        '<span class="search-row-main"><span class="search-row-title">' +
        escapeHtml(name) +
        '</span></span>' +
        (tier ? '<span class="search-row-meta">' + escapeHtml(tier) + '</span>' : ''),
      hash: '#groups',
      target: row
    })
  })
  return out
}

function connectorItems(): SearchItem[] {
  var out: SearchItem[] = []
  document.querySelectorAll<HTMLElement>('[data-connector-row]').forEach(function (row) {
    var label = row.getAttribute('data-connector-label') || ''
    var kind = row.getAttribute('data-connector-kind') || ''
    if (!label) return
    out.push({
      kind: 'connector',
      hay: (label + ' ' + kind).toLowerCase(),
      html:
        '<span class="search-row-main"><span class="search-row-title">' +
        escapeHtml(label) +
        '</span></span>' +
        (kind ? '<span class="search-row-meta">' + escapeHtml(kind) + '</span>' : ''),
      hash: '#connectors',
      target: row
    })
  })
  return out
}

function escapeHtml(s: string): string {
  var div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function buildIndex(): void {
  index = seatItems().concat(licenseItems(), groupItems(), connectorItems())
}

function matches(query: string): SearchItem[] {
  return index.filter(function (item) {
    return item.hay.indexOf(query) >= 0
  })
}

function fillSeatRowText(item: SearchItem, row: HTMLElement): void {
  var title = row.querySelector<HTMLElement>('.search-row-title')
  var sub = row.querySelector<HTMLElement>('.search-row-sub')
  if (title) title.textContent = item.title || 'Seat'
  if (sub) sub.textContent = item.sub || ''
}

function renderDropdown(query: string): void {
  if (!resultsEl) return
  resultsEl.textContent = ''
  flat = []

  if (!query) {
    resultsEl.hidden = true
    activeIndex = -1
    return
  }

  var found = matches(query)
  if (!found.length) {
    var empty = document.createElement('p')
    empty.className = 'search-empty'
    empty.textContent = 'No matches for "' + query + '"'
    resultsEl.appendChild(empty)
    resultsEl.hidden = false
    activeIndex = -1
    return
  }

  GROUP_ORDER.forEach(function (kind) {
    var groupItemsFound = found.filter(function (item) {
      return item.kind === kind
    })
    if (!groupItemsFound.length) return
    var group = document.createElement('div')
    group.className = 'search-group'
    var label = document.createElement('p')
    label.className = 'search-group-label'
    label.textContent = GROUP_LABEL[kind]
    group.appendChild(label)
    groupItemsFound.slice(0, MAX_PER_GROUP).forEach(function (item) {
      var row = document.createElement('button')
      row.type = 'button'
      row.className = 'search-row'
      row.setAttribute('role', 'option')
      row.innerHTML = item.html
      if (item.kind === 'seat') fillSeatRowText(item, row)
      var flatIndex = flat.length
      row.setAttribute('data-search-index', String(flatIndex))
      row.addEventListener('click', function () {
        choose(flatIndex)
      })
      group.appendChild(row)
      flat.push(item)
    })
    if (groupItemsFound.length > MAX_PER_GROUP) {
      var more = document.createElement('p')
      more.className = 'search-more'
      more.textContent = String(groupItemsFound.length - MAX_PER_GROUP) + ' more'
      group.appendChild(more)
    }
    resultsEl!.appendChild(group)
  })

  activeIndex = flat.length ? 0 : -1
  resultsEl.hidden = false
  highlightActive()
}

function highlightActive(): void {
  if (!resultsEl) return
  resultsEl.querySelectorAll<HTMLElement>('[data-search-index]').forEach(function (row) {
    var isOn = row.getAttribute('data-search-index') === String(activeIndex)
    row.classList.toggle('on', isOn)
    row.setAttribute('aria-selected', isOn ? 'true' : 'false')
  })
}

function moveActive(delta: number): void {
  if (!flat.length) return
  activeIndex = (activeIndex + delta + flat.length) % flat.length
  highlightActive()
  var row = resultsEl && resultsEl.querySelector<HTMLElement>('[data-search-index="' + activeIndex + '"]')
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
}

function choose(i: number): void {
  var item = flat[i]
  if (!item) return
  closeDropdown()
  if (location.hash !== item.hash) location.hash = item.hash
  if (item.target) item.target.click()
}

function closeDropdown(): void {
  if (resultsEl) resultsEl.hidden = true
  activeIndex = -1
}

function clearSearch(): void {
  if (inputEl) inputEl.value = ''
  closeDropdown()
  if (inputEl) inputEl.blur()
}

function scheduleRefresh(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(function () {
    if (!inputEl) return
    renderDropdown(inputEl.value.trim().toLowerCase())
  }, DEBOUNCE_MS)
}

function clearGWait(): void {
  awaitingG = false
  if (awaitingGTimer) {
    clearTimeout(awaitingGTimer)
    awaitingGTimer = null
  }
}

export function initSearch(): void {
  inputEl = document.getElementById('nav-search') as HTMLInputElement | null
  resultsEl = document.querySelector('[data-search-results]')
  buildIndex()

  window.addEventListener('metis:live', buildIndex)

  if (inputEl) {
    inputEl.addEventListener('input', scheduleRefresh)
    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        moveActive(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        moveActive(-1)
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0) {
          e.preventDefault()
          choose(activeIndex)
        }
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        clearSearch()
      }
    })
  }

  document.addEventListener('click', function (e) {
    var shell = document.querySelector('[data-rail-search]')
    if (shell && !shell.contains(e.target as Node)) closeDropdown()
  })

  document.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key === 'Escape') {
      var openDrawer = document.querySelector<HTMLElement>('.seat-overlay:not([hidden])')
      if (openDrawer) openDrawer.hidden = true
      return
    }

    if (isEditableTarget(e.target)) return

    if (e.key === '/') {
      e.preventDefault()
      if (inputEl) inputEl.focus()
      return
    }
    if (awaitingG) {
      var pressed = e.key
      clearGWait()
      var dest = GO_CHORDS[pressed]
      if (dest) {
        e.preventDefault()
        location.hash = '#' + dest
      }
      return
    }
    if (e.key === 'g') {
      awaitingG = true
      awaitingGTimer = setTimeout(clearGWait, GO_CHORD_TIMEOUT_MS)
    }
  })
}
