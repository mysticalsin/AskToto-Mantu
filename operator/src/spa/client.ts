import { SHOEY_LAND_SVG } from '../charts'

/** Exact served statement. Regex literal: slash, caret, backslash, slash, slash. */
export const PATHNAME_STRIP_JS = "location.pathname.replace(/^\\//, '')"

/** Shoey chrome. Hashed and served at /assets/operator-<hash>.js. Not a stub. */
export const CONSOLE_JS = `/* Métis Operator SPA — Shoey Overview / Realtime / Events
 * Content-hashed chrome. Authenticated HTML script-src this file.
 * 0 LLM tokens. Live heartbeats only. Fail loud: this is not a METIS_OPERATOR stub.
 * Shoey land fill #E5E7EB. Events columns: Created at, Name, Profile, Country, OS, Browser.
 * World land is inlined in #map-root HTML as path[data-iso]. paintShoeyMap only restyles theme.
 */
(function metisOperatorSpa() {
  'use strict'
  var pages = ['overview', 'realtime', 'events', 'sessions', 'notifications', 'keys', 'settings']
  self.METIS_OPERATOR_SPA = {
    chrome: 'shoey',
    product: 'Métis Operator',
    pages: pages,
    nav: pages,
    hydrate: 'post-access'
  }

  var sessionBearer = ''

  async function ensureSession() {
    if (sessionBearer) return
    try {
      var ping = await fetch('/session', {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' }
      })
      var issued = ping.headers && ping.headers.get && ping.headers.get('X-Metis-Session')
      if (issued) sessionBearer = issued
      var pingText = await ping.text()
      try {
        var pingJson = JSON.parse(pingText)
        if (pingJson && pingJson.session) sessionBearer = pingJson.session
      } catch (e) {}
    } catch (e) {}
  }

  async function api(path, body) {
    await ensureSession()
    var r
    var headers = { accept: 'application/json' }
    if (body) headers['content-type'] = 'application/json'
    if (sessionBearer) headers.authorization = 'Bearer ' + sessionBearer
    try {
      r = await fetch(path, {
        method: body ? 'POST' : 'GET',
        credentials: 'include',
        headers: headers,
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      return { ok: false, error: 'network failed' }
    }
    try {
      var issued = r.headers && r.headers.get && r.headers.get('X-Metis-Session')
      if (issued) sessionBearer = issued
    } catch (e) {}
    var text = await r.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      if (!text || looksLikeAccessHtml(text)) {
        return { ok: false, error: 'Access required. Sign in with Cloudflare Access and retry Add.' }
      }
      return { ok: false, error: text.slice(0, 180) || ('HTTP ' + r.status) }
    }
  }

  var titles = {
    overview: 'Overview', realtime: 'Realtime', events: 'Events', sessions: 'Sessions',
    notifications: 'Notifications', keys: 'Keys', settings: 'Settings', map: 'Realtime'
  }

  function route(to) {
    if (typeof to === 'string') {
      var next = to
      if (next.charAt(0) === '#') next = next.slice(1)
      if (next.charAt(0) === '/') next = next.slice(1)
      if (!next) next = 'realtime'
      if (titles[next] || next === 'map') {
        var want = '#' + next
        if (location.hash !== want) location.hash = want
      }
    }
    // WebsiteCloner / OpenPanel Realtime is the home surface — land there unless a hash is set.
    var raw = (location.hash || '#realtime').replace('#', '')
    var requested = titles[raw] ? raw : 'realtime'
    var id = requested === 'map' ? 'realtime' : requested
    document.querySelectorAll('[data-page]').forEach(function (p) {
      var show = p.getAttribute('data-page') === id
      p.hidden = !show
      if (show && p.classList) {
        p.classList.remove('page-enter')
        try { void p.offsetWidth } catch (e) {}
        p.classList.add('page-enter')
      }
    })
    var navOn = requested === 'map' ? 'realtime' : requested
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === navOn)
    })
    var t = document.getElementById('page-title')
    if (t) t.textContent = titles[id]
    if (id === 'realtime') paintShoeyMap()
    if (id === 'events') applyEventsFilter()
  }
  window.route = route

  var SHOEY_LAND_SVG = ${JSON.stringify(SHOEY_LAND_SVG)}

  function ensureShoeyLand(root) {
    if (root.querySelector('path[data-iso]')) return
    // HTML already inlines land (#map-root[data-land=inline]). This is a last-resort restyle helper, not the map.
    var box = document.createElement('div')
    box.innerHTML = SHOEY_LAND_SVG
    var fresh = box.querySelector('svg.shoey-world')
    if (!fresh) return
    var old = root.querySelector('svg.world')
    if (old && old.querySelectorAll) {
      old.querySelectorAll('g.seat-mark, circle.seat-dot, circle.dot, g.pill-g').forEach(function (n) {
        fresh.appendChild(n)
      })
    }
    if (old && typeof old.replaceWith === 'function') {
      old.replaceWith(fresh)
    } else if (old && old.parentNode && old.parentNode.replaceChild) {
      old.parentNode.replaceChild(fresh, old)
    } else {
      root.insertBefore(fresh, root.firstChild)
    }
  }

  function paintShoeyMap() {
    var root = document.getElementById('map-root')
    if (!root) return
    ensureShoeyLand(root)
    var dark = document.documentElement.getAttribute('data-theme') === 'dark'
    var land = dark ? '#3f3f46' : '#E5E7EB'
    var ocean = dark ? '#0a0a0b' : '#FFFFFF'
    var stroke = dark ? '#111827' : '#6B7280'
    root.querySelectorAll('.world-ocean').forEach(function (r) {
      r.setAttribute('fill', ocean)
    })
    root.querySelectorAll('path[data-iso]').forEach(function (p) {
      p.setAttribute('fill', land)
      p.setAttribute('stroke', stroke)
      p.setAttribute('stroke-width', '1.15')
      p.setAttribute('class', ((p.getAttribute('class') || '') + ' world-land').trim())
    })
    var svg = root.querySelector('svg.shoey-world')
    if (svg) svg.setAttribute('data-land', '#E5E7EB')
  }

  window.addEventListener('hashchange', route)
  if (!location.hash) {
    var path = ${PATHNAME_STRIP_JS}
    if (path && titles[path]) location.hash = '#' + path
    else location.hash = '#realtime'
  }
  route()

  document.querySelectorAll('[data-vol-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-vol-tab') || ''
      var group = key.split(':')[0]
      document.querySelectorAll('[data-vol-tab^="' + group + ':"]').forEach(function (x) {
        x.classList.toggle('on', x === b)
      })
      document.querySelectorAll('[data-vol-pane^="' + group + ':"]').forEach(function (p) {
        p.hidden = p.getAttribute('data-vol-pane') !== key
      })
    })
  })

  document.querySelectorAll('[data-vol-search]').forEach(function (input) {
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase()
      var id = input.getAttribute('data-vol-search')
      document.querySelectorAll('[data-vol-pane^="' + id + ':"] .vol-row[data-q]').forEach(function (row) {
        row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
      })
    })
  })

  function syncEmpty(rowsSel, emptyId) {
    var empty = document.getElementById(emptyId)
    if (!empty) return
    var rows = document.querySelectorAll(rowsSel)
    var shown = 0
    rows.forEach(function (row) {
      if (!row.hidden) shown += 1
    })
    empty.hidden = shown > 0
  }

  var evSearch = document.getElementById('events-search')
  function applyEventsFilter() {
    var input = document.getElementById('events-search') || evSearch
    var q = String(input && input.value || '').trim().toLowerCase()
    document.querySelectorAll('#events-list .event[data-q]').forEach(function (row) {
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
      var t = e && e.target
      if (t && t.id === 'events-search') applyEventsFilter()
    })
    document.addEventListener('search', function (e) {
      var t = e && e.target
      if (t && t.id === 'events-search') applyEventsFilter()
    })
  }
  var evFilters = document.getElementById('events-filters')
  if (evFilters && evSearch) {
    evFilters.addEventListener('click', function () { evSearch.focus() })
  }
  document.querySelectorAll('[data-ev-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-ev-tab') || 'events'
      document.querySelectorAll('[data-ev-tab]').forEach(function (x) { x.classList.toggle('on', x === b) })
      document.querySelectorAll('[data-ev-pane]').forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-ev-pane') !== id
      })
    })
  })
  document.querySelectorAll('[data-nt-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-nt-tab') || 'notifications'
      document.querySelectorAll('[data-nt-tab]').forEach(function (x) { x.classList.toggle('on', x === b) })
      document.querySelectorAll('[data-nt-pane]').forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-nt-pane') !== id
      })
    })
  })

  var sessSearch = document.getElementById('sessions-search')
  function applySessionsFilter() {
    var q = sessSearch ? sessSearch.value.trim().toLowerCase() : ''
    document.querySelectorAll('[data-seat-row]').forEach(function (row) {
      row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
    })
    syncEmpty('[data-seat-row]', 'sessions-empty')
  }
  if (sessSearch) {
    sessSearch.addEventListener('input', applySessionsFilter)
    sessSearch.addEventListener('search', applySessionsFilter)
    sessSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applySessionsFilter() }
    })
  }
  var sessFilters = document.getElementById('sessions-filters')
  if (sessFilters && sessSearch) {
    sessFilters.addEventListener('click', function () { sessSearch.focus() })
  }

  var ntFilter = 'all'
  var ntSearch = document.getElementById('nt-search')
  function applyNtFilter() {
    var q = ntSearch ? ntSearch.value.trim().toLowerCase() : ''
    document.querySelectorAll('#nt-table [data-nt-row]').forEach(function (row) {
      var status = row.getAttribute('data-status') || ''
      var text = (row.textContent || '').toLowerCase()
      var statusOk = ntFilter === 'all' || status === ntFilter
      var qOk = !q || text.includes(q)
      row.hidden = !(statusOk && qOk)
    })
    var empty = document.querySelector('#nt-table [data-nt-empty]')
    if (empty) {
      var shown = 0
      document.querySelectorAll('#nt-table [data-nt-row]').forEach(function (row) {
        if (!row.hidden) shown += 1
      })
      empty.hidden = shown > 0
    }
  }
  if (ntSearch) ntSearch.addEventListener('input', applyNtFilter)

  var themeBtn = document.getElementById('theme-btn')
  function applyTheme(v) {
    var theme = v === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
  }
  try { applyTheme(localStorage.getItem('metis-operator-theme') || 'dark') } catch (e) { applyTheme('dark') }
  paintShoeyMap()
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme')
      var next = cur === 'dark' ? 'light' : 'dark'
      document.documentElement.classList.add('theme-fade')
      applyTheme(next)
      paintShoeyMap()
      try { localStorage.setItem('metis-operator-theme', next) } catch (e) {}
      window.setTimeout(function () {
        document.documentElement.classList.remove('theme-fade')
      }, 320)
    })
  }

  function clearLiveFocus() {
    document.querySelectorAll('.rt-seat.on, .seat-mark.on, .geo-row.on, #map-root path[data-iso].on').forEach(function (el) {
      el.classList.remove('on')
    })
  }

  function focusLiveSeat(device) {
    if (!device) return
    clearLiveFocus()
    document.querySelectorAll('.rt-seat[data-device]').forEach(function (el) {
      var on = el.getAttribute('data-device') === device
      el.classList.toggle('on', on)
      if (on) {
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch (e) {}
      }
    })
    document.querySelectorAll('.seat-mark[data-device]').forEach(function (el) {
      el.classList.toggle('on', el.getAttribute('data-device') === device)
    })
    var seat = document.querySelector('.rt-seat[data-device="' + device + '"]')
    var iso = seat && seat.getAttribute('data-iso')
    if (iso) {
      document.querySelectorAll('#map-root path[data-iso="' + iso + '"]').forEach(function (p) {
        p.classList.add('on')
      })
      document.querySelectorAll('.geo-row[data-iso="' + iso + '"]').forEach(function (row) {
        row.classList.add('on')
      })
    }
  }

  function focusLiveIso(iso) {
    clearLiveFocus()
    if (!iso) return
    document.querySelectorAll('#map-root path[data-iso="' + iso + '"]').forEach(function (p) {
      p.classList.add('on')
    })
    document.querySelectorAll('.geo-row').forEach(function (row) {
      var on = row.getAttribute('data-iso') === iso
      row.classList.toggle('on', on)
      row.hidden = !on
    })
    document.querySelectorAll('.rt-seat').forEach(function (el) {
      var on = el.getAttribute('data-iso') === iso
      el.classList.toggle('on', on)
      el.hidden = !on
    })
    document.querySelectorAll('.seat-mark').forEach(function (el) {
      el.classList.toggle('on', el.getAttribute('data-iso') === iso)
    })
  }

  function clearGeoFilter() {
    document.querySelectorAll('.geo-row, .rt-seat').forEach(function (el) { el.hidden = false })
    clearLiveFocus()
  }

  document.querySelectorAll('.seat-mark[data-device]').forEach(function (g) {
    g.addEventListener('click', function (ev) {
      ev.stopPropagation()
      focusLiveSeat(g.getAttribute('data-device'))
    })
    g.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        focusLiveSeat(g.getAttribute('data-device'))
      }
    })
  })

  document.querySelectorAll('.rt-seat[data-device]').forEach(function (el) {
    el.addEventListener('click', function () {
      focusLiveSeat(el.getAttribute('data-device'))
    })
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        focusLiveSeat(el.getAttribute('data-device'))
      }
    })
  })

  document.querySelectorAll('.geo-row[data-iso]').forEach(function (row) {
    row.addEventListener('click', function () {
      var iso = row.getAttribute('data-iso') || ''
      if (row.classList.contains('on')) clearGeoFilter()
      else focusLiveIso(iso)
    })
  })

  function addSeatField(body, label, value, wide) {
    var field = document.createElement('div')
    field.className = wide ? 'seat-field seat-overlay-wide' : 'seat-field'
    var k = document.createElement('span')
    k.className = 'lbl'
    k.textContent = label
    var v = document.createElement('span')
    v.className = 'val'
    v.textContent = value
    field.appendChild(k)
    field.appendChild(v)
    body.appendChild(field)
    return field
  }
  function fillSeatOverlay(row) {
    var overlay = document.getElementById('seat-overlay')
    if (!overlay) return
    overlay.hidden = false
    var title = overlay.querySelector('[data-seat-title]')
    var no = overlay.querySelector('[data-seat-no]')
    var body = overlay.querySelector('[data-seat-body]')
    var computer = row.getAttribute('data-seat-computer') || '—'
    if (title) title.textContent = computer
    if (no) no.textContent = row.getAttribute('data-seat-no') || ''
    if (!body) return
    body.textContent = ''
    addSeatField(body, 'Computer', computer)
    addSeatField(body, 'OS', row.getAttribute('data-os') || '—')
    addSeatField(body, 'Location', row.getAttribute('data-seat-location') || '—')
    addSeatField(body, 'IP', row.getAttribute('data-seat-ip') || '—')
    addSeatField(body, 'License', row.getAttribute('data-seat-license') || '—')
    addSeatField(body, 'Identity', row.getAttribute('data-seat-identity') || '—')
    addSeatField(body, 'Last seen', row.getAttribute('data-seat-last') || '—')
    addSeatField(body, 'Version', row.getAttribute('data-seat-version') || '—')
    var statusField = addSeatField(body, 'Status', '')
    var pill = document.createElement('span')
    var statusId = row.getAttribute('data-seat-status-id') || 'inactive'
    pill.className = 'seat-status ' + statusId
    pill.textContent = row.getAttribute('data-seat-status') || 'Inactive'
    statusField.querySelector('.val').appendChild(pill)
    var meterField = addSeatField(body, 'Heartbeat', '', true)
    var meter = document.createElement('div')
    meter.className = 'seat-meter'
    var fill = document.createElement('i')
    fill.style.width = (row.getAttribute('data-seat-meter') || '8') + '%'
    meter.appendChild(fill)
    meterField.querySelector('.val').appendChild(meter)
    var barsField = addSeatField(body, 'Heartbeat bars', '', true)
    var hbars = document.createElement('div')
    hbars.className = 'seat-hbars'
    ;(row.getAttribute('data-seat-bars') || '8').split(',').forEach(function (n) {
      var bar = document.createElement('i')
      var v = Math.max(8, Math.min(100, parseInt(n, 10) || 8))
      bar.style.height = v + '%'
      hbars.appendChild(bar)
    })
    barsField.querySelector('.val').appendChild(hbars)
    var recent = row.getAttribute('data-seat-recent') || ''
    addSeatField(body, 'Recent', recent || 'No recent heartbeats for this seat.', true)
  }
  document.querySelectorAll('[data-seat-row]').forEach(function (row) {
    row.addEventListener('click', function () { fillSeatOverlay(row) })
  })
  var seatClose = document.getElementById('seat-overlay-close')
  if (seatClose) {
    seatClose.addEventListener('click', function () {
      var overlay = document.getElementById('seat-overlay')
      if (overlay) overlay.hidden = true
    })
  }

  document.querySelectorAll('[data-scale]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-scale]').forEach(function (x) { x.classList.toggle('on', x === b) })
      document.getElementById('scale-24').hidden = b.getAttribute('data-scale') !== '24h'
      document.getElementById('scale-7').hidden = b.getAttribute('data-scale') !== '7d'
    })
  })

  document.querySelectorAll('#map-root path[data-iso]').forEach(function (p) {
    p.addEventListener('click', function () {
      var iso = p.getAttribute('data-iso')
      document.querySelectorAll('[data-vol-pane="geo:geo"] .vol-row[data-q]').forEach(function (row) {
        row.hidden = Boolean(iso) && !(row.getAttribute('data-q') || '').toUpperCase().includes(iso)
      })
      if (iso && p.classList.contains('on')) clearGeoFilter()
      else if (iso) focusLiveIso(iso)
    })
  })

  document.querySelectorAll('[data-crm-filter]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('[data-crm-filter]').forEach(function (x) { x.classList.toggle('on', x === b) })
      ntFilter = b.getAttribute('data-crm-filter') || 'all'
      applyNtFilter()
      document.querySelectorAll('#crm-table tbody tr').forEach(function (tr) {
        tr.hidden = ntFilter !== 'all' && tr.getAttribute('data-status') !== ntFilter
      })
    })
  })

  document.querySelectorAll('[data-reveal]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reveal')
      var j = await api('/v1/admin/asks/' + id)
      document.getElementById('reveal').textContent = j.ok ? (j.question || '(empty)') : (j.error || 'reveal failed')
    })
  })

  document.querySelectorAll('[data-approve]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-approve')
      var diff = document.querySelector('[data-diff="' + id + '"]').value
      await api('/v1/admin/skills/' + id + '/approve', { diff: diff })
      location.reload()
    })
  })

  document.querySelectorAll('[data-reject]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reject')
      await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
      location.reload()
    })
  })

  document.querySelectorAll('[data-push]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-push')
      await api('/v1/admin/skills/' + id + '/push', {})
      location.reload()
    })
  })

  document.querySelectorAll('[data-draft]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
      location.reload()
    })
  })

  document.querySelectorAll('[data-retry]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/crm/' + b.getAttribute('data-retry') + '/retry', {})
      location.reload()
    })
  })

  function looksLikeAccessHtml(text) {
    var t = String(text || '').toLowerCase()
    return t.indexOf('<!doctype') >= 0 || t.indexOf('<html') >= 0 || t.indexOf('cf-access') >= 0
  }

  function showKey(el, j) {
    if (!el) return
    if (j && j.ok) {
      el.className = 'key-msg ok'
      el.textContent = j.last4 ? ('saved ··' + j.last4) : (j.status || 'ok')
    } else {
      el.className = 'key-msg fail-loud'
      var err = (j && j.error) || 'Add failed'
      if (err === 'Access required' || looksLikeAccessHtml(err)) {
        err = 'Access required. Sign in with Cloudflare Access and retry Add.'
      }
      el.textContent = err
    }
  }

  function bindKeyAdd(form, msgId) {
    if (!form) return
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      var msg = document.getElementById(msgId || 'key-msg')
      var fd = new FormData(form)
      var j = await api('/v1/admin/keys', {
        provider: fd.get('provider'),
        label: fd.get('label'),
        secret: fd.get('secret')
      })
      showKey(msg, j)
      if (j && j.ok) location.reload()
    })
  }
  bindKeyAdd(document.getElementById('key-add'), 'key-msg')
  bindKeyAdd(document.getElementById('key-add-settings'), 'key-msg-settings')

  document.querySelectorAll('[data-rotate]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var secret = window.prompt('New secret or token')
      if (!secret) return
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-rotate') + '/rotate', { secret: secret })
      if (j && j.ok) location.reload()
      else showKey(document.getElementById('key-msg'), j)
    })
  })

  document.querySelectorAll('[data-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-revoke') + '/revoke', {})
      if (j && j.ok) location.reload()
      else showKey(document.getElementById('key-msg'), j)
    })
  })
})();
`
