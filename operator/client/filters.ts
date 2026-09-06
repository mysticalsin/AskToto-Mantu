/** Tab groups, search boxes, and filter chips shared across sections. */

function syncEmpty(rowsSel: string, emptyId: string): void {
  var empty = document.getElementById(emptyId)
  if (!empty) return
  var rows = document.querySelectorAll<HTMLElement>(rowsSel)
  var shown = 0
  rows.forEach(function (row) {
    if (!row.hidden) shown += 1
  })
  empty.hidden = shown > 0
}

/** Generic `[data-vol-tab]` / `[data-vol-pane]` tab groups (Overview 2x2, etc). */
export function initVolumeTabs(): void {
  document.querySelectorAll<HTMLElement>('[data-vol-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-vol-tab') || ''
      var group = key.split(':')[0]
      document.querySelectorAll<HTMLElement>('[data-vol-tab^="' + group + ':"]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.querySelectorAll<HTMLElement>('[data-vol-pane^="' + group + ':"]').forEach(function (p) {
        p.hidden = p.getAttribute('data-vol-pane') !== key
      })
    })
  })
}

export function initVolumeSearch(): void {
  document.querySelectorAll<HTMLInputElement>('[data-vol-search]').forEach(function (input) {
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase()
      var id = input.getAttribute('data-vol-search')
      document.querySelectorAll<HTMLElement>('[data-vol-pane^="' + id + ':"] .vol-row[data-q]').forEach(function (row) {
        row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
      })
    })
  })
}

let evSearchCached: HTMLInputElement | null = null

export function applyEventsFilter(): void {
  var input = (document.getElementById('events-search') as HTMLInputElement | null) || evSearchCached
  var q = String((input && input.value) || '').trim().toLowerCase()
  document.querySelectorAll<HTMLElement>('#events-list .event[data-q]').forEach(function (row) {
    var hay = (row.getAttribute('data-q') || '').toLowerCase()
    var hit = !q || hay.indexOf(q) >= 0
    row.hidden = !hit
    if (row.classList && row.classList.toggle) row.classList.toggle('is-hidden', !hit)
    if (row.style) row.style.display = hit ? '' : 'none'
    if (!hit && row.setAttribute) row.setAttribute('hidden', 'hidden')
    if (hit && row.removeAttribute) row.removeAttribute('hidden')
  })
  syncEmpty('#events-list .event[data-q]', 'events-empty')
}

export function initEventsFilters(): void {
  var evSearch = document.getElementById('events-search') as HTMLInputElement | null
  evSearchCached = evSearch
  if (evSearch) {
    evSearch.addEventListener('input', applyEventsFilter)
    evSearch.addEventListener('search', applyEventsFilter)
    evSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        applyEventsFilter()
      }
    })
  }
  if (document.addEventListener) {
    document.addEventListener('input', function (e) {
      var t = e && (e.target as HTMLElement | null)
      if (t && t.id === 'events-search') applyEventsFilter()
    })
    document.addEventListener('search', function (e) {
      var t = e && (e.target as HTMLElement | null)
      if (t && t.id === 'events-search') applyEventsFilter()
    })
  }
  var evFilters = document.getElementById('events-filters')
  if (evFilters && evSearch) {
    evFilters.addEventListener('click', function () {
      evSearch!.focus()
    })
  }
}

export function initEvTabs(): void {
  document.querySelectorAll<HTMLElement>('[data-ev-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-ev-tab') || 'events'
      document.querySelectorAll<HTMLElement>('[data-ev-tab]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.querySelectorAll<HTMLElement>('[data-ev-pane]').forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-ev-pane') !== id
      })
    })
  })
}

export function initNtTabs(): void {
  document.querySelectorAll<HTMLElement>('[data-nt-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-nt-tab') || 'notifications'
      document.querySelectorAll<HTMLElement>('[data-nt-tab]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.querySelectorAll<HTMLElement>('[data-nt-pane]').forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-nt-pane') !== id
      })
    })
  })
}

export function initSessionsFilter(): void {
  var sessSearch = document.getElementById('sessions-search') as HTMLInputElement | null
  function applySessionsFilter(): void {
    var q = sessSearch ? sessSearch.value.trim().toLowerCase() : ''
    document.querySelectorAll<HTMLElement>('[data-seat-row]').forEach(function (row) {
      row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
    })
    syncEmpty('[data-seat-row]', 'sessions-empty')
  }
  if (sessSearch) {
    sessSearch.addEventListener('input', applySessionsFilter)
    sessSearch.addEventListener('search', applySessionsFilter)
    sessSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        applySessionsFilter()
      }
    })
  }
  var sessFilters = document.getElementById('sessions-filters')
  if (sessFilters && sessSearch) {
    sessFilters.addEventListener('click', function () {
      sessSearch!.focus()
    })
  }
}

let ntFilter = 'all'
let ntSearchCached: HTMLInputElement | null = null

function applyNtFilter(): void {
  var ntSearch = ntSearchCached
  var q = ntSearch ? ntSearch.value.trim().toLowerCase() : ''
  document.querySelectorAll<HTMLElement>('#nt-table [data-nt-row]').forEach(function (row) {
    var status = row.getAttribute('data-status') || ''
    var text = (row.textContent || '').toLowerCase()
    var statusOk = ntFilter === 'all' || status === ntFilter
    var qOk = !q || text.includes(q)
    row.hidden = !(statusOk && qOk)
  })
  var empty = document.querySelector<HTMLElement>('#nt-table [data-nt-empty]')
  if (empty) {
    var shown = 0
    document.querySelectorAll<HTMLElement>('#nt-table [data-nt-row]').forEach(function (row) {
      if (!row.hidden) shown += 1
    })
    empty.hidden = shown > 0
  }
}

export function initNtFilter(): void {
  ntSearchCached = document.getElementById('nt-search') as HTMLInputElement | null
  if (ntSearchCached) ntSearchCached.addEventListener('input', applyNtFilter)
}

export function initScaleButtons(): void {
  document.querySelectorAll<HTMLElement>('[data-scale]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll<HTMLElement>('[data-scale]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.getElementById('scale-24')!.hidden = b.getAttribute('data-scale') !== '24h'
      document.getElementById('scale-7')!.hidden = b.getAttribute('data-scale') !== '7d'
    })
  })
}

export function initCrmFilter(): void {
  document.querySelectorAll<HTMLElement>('[data-crm-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll<HTMLElement>('[data-crm-filter]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      ntFilter = b.getAttribute('data-crm-filter') || 'all'
      applyNtFilter()
      document.querySelectorAll<HTMLElement>('#crm-table tbody tr').forEach(function (tr) {
        tr.hidden = ntFilter !== 'all' && tr.getAttribute('data-status') !== ntFilter
      })
    })
  })
}
