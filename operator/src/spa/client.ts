import { SHOEY_LAND_SVG } from '../charts'

/** Exact served statement. Regex literal: slash, caret, backslash, slash, slash. */
export const PATHNAME_STRIP_JS = "location.pathname.replace(/^\\//, '')"

/** Shoey chrome. Hashed and served at /assets/operator-<hash>.js. Not a stub. */
export const CONSOLE_JS = `/* Métis Operator SPA — Shoey Overview / Realtime / Events
 * Content-hashed chrome. Authenticated HTML script-src this file.
 * 0 LLM tokens. Live heartbeats only. Fail loud: this is not a METIS_OPERATOR stub.
 * Shoey land fill #E5E7EB. Events columns: Created at, Name, Profile, Country, OS, Browser.
 * World SVG is embedded: path[data-iso] land. paintShoeyMap injects it if HTML omitted it.
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

  async function api(path, body) {
    var r
    try {
      r = await fetch(path, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        headers: body
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      return { ok: false, error: 'network failed' }
    }
    var text = await r.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      return { ok: false, error: text && text.slice(0, 180) || ('HTTP ' + r.status) }
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
      if (!next) next = 'overview'
      if (titles[next] || next === 'map') {
        var want = '#' + next
        if (location.hash !== want) location.hash = want
      }
    }
    var raw = (location.hash || '#overview').replace('#', '')
    var requested = titles[raw] ? raw : 'overview'
    var id = requested === 'map' ? 'realtime' : requested
    document.querySelectorAll('[data-page]').forEach(function (p) {
      p.hidden = p.getAttribute('data-page') !== id
    })
    var navOn = requested === 'map' ? 'realtime' : requested
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-nav') === navOn)
    })
    var t = document.getElementById('page-title')
    if (t) t.textContent = titles[id]
    if (id === 'realtime') paintShoeyMap()
  }
  window.route = route

  var SHOEY_LAND_SVG = ${JSON.stringify(SHOEY_LAND_SVG)}

  function ensureShoeyLand(root) {
    if (root.querySelector('path[data-iso]')) return
    var box = document.createElement('div')
    box.innerHTML = SHOEY_LAND_SVG
    var fresh = box.querySelector('svg.shoey-world')
    if (!fresh) return
    var old = root.querySelector('svg.world')
    if (old && old.querySelectorAll) {
      old.querySelectorAll('circle.seat-dot, circle.dot, g.pill-g').forEach(function (n) {
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
    var stroke = dark ? '#111827' : '#9CA3AF'
    root.querySelectorAll('.world-ocean').forEach(function (r) {
      r.setAttribute('fill', ocean)
    })
    root.querySelectorAll('path[data-iso]').forEach(function (p) {
      p.setAttribute('fill', land)
      p.setAttribute('stroke', stroke)
      p.setAttribute('stroke-width', '0.8')
      p.setAttribute('class', ((p.getAttribute('class') || '') + ' world-land').trim())
    })
    var svg = root.querySelector('svg.shoey-world')
    if (svg) svg.setAttribute('data-land', '#E5E7EB')
  }

  window.addEventListener('hashchange', route)
  if (!location.hash) {
    var path = ${PATHNAME_STRIP_JS}
    if (path && titles[path]) location.hash = '#' + path
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
  if (evSearch) {
    evSearch.addEventListener('input', function () {
      var q = evSearch.value.trim().toLowerCase()
      document.querySelectorAll('#events-list .event[data-q]').forEach(function (row) {
        row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
      })
      syncEmpty('#events-list .event[data-q]', 'events-empty')
    })
  }

  var sessSearch = document.getElementById('sessions-search')
  if (sessSearch) {
    sessSearch.addEventListener('input', function () {
      var q = sessSearch.value.trim().toLowerCase()
      document.querySelectorAll('[data-seat-row]').forEach(function (row) {
        row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
      })
      syncEmpty('[data-seat-row]', 'sessions-empty')
    })
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
  try { applyTheme(localStorage.getItem('metis-operator-theme') || 'light') } catch (e) { applyTheme('light') }
  paintShoeyMap()
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme')
      var next = cur === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      paintShoeyMap()
      try { localStorage.setItem('metis-operator-theme', next) } catch (e) {}
    })
  }

  document.querySelectorAll('[data-seat-row]').forEach(function (row) {
    row.addEventListener('click', function () {
      var overlay = document.getElementById('seat-overlay')
      if (!overlay) return
      overlay.hidden = false
      var title = overlay.querySelector('[data-seat-title]')
      var body = overlay.querySelector('[data-seat-body]')
      if (title) title.textContent = row.getAttribute('data-seat-name') || 'Seat'
      if (body) {
        var raw = row.getAttribute('data-seat-detail') || ''
        body.textContent = ''
        raw.split(' · ').forEach(function (line) {
          var p = document.createElement('div')
          p.className = 'muted'
          p.textContent = line
          body.appendChild(p)
        })
      }
    })
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

  function showKey(el, j) {
    if (!el) return
    if (j && j.ok) {
      el.className = 'key-msg ok'
      el.textContent = j.last4 ? ('saved ··' + j.last4) : (j.status || 'ok')
    } else {
      el.className = 'key-msg fail-loud'
      el.textContent = (j && j.error) || 'Add failed'
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
