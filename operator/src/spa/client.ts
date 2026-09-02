/** Shoey chrome. Hashed and served at /assets/operator-<hash>.js. Not a stub. */
export const CONSOLE_JS = `/* Métis Operator SPA — Shoey Overview / Realtime / Events
 * Content-hashed chrome. Authenticated HTML script-src this file.
 * 0 LLM tokens. Live heartbeats only. Fail loud: this is not a METIS_OPERATOR stub.
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
    var r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    })
    return r.json()
  }

  var titles = {
    overview: 'Overview', realtime: 'Realtime', events: 'Events', sessions: 'Sessions',
    notifications: 'Notifications', keys: 'Keys', settings: 'Settings', map: 'Realtime'
  }

  function route() {
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
  }

  window.addEventListener('hashchange', route)
  if (!location.hash) {
    var path = location.pathname.replace(/^\\//, '')
    if (path && titles[path]) location.hash = '#' + path
  }
  route()

  var createBtn = document.getElementById('create-report')
  var createMenu = document.getElementById('create-menu')
  if (createBtn && createMenu) {
    createBtn.addEventListener('click', function () { createMenu.classList.toggle('open') })
  }

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

  var evSearch = document.getElementById('events-search')
  if (evSearch) {
    evSearch.addEventListener('input', function () {
      var q = evSearch.value.trim().toLowerCase()
      document.querySelectorAll('#events-list .event').forEach(function (row) {
        row.hidden = Boolean(q) && !(row.getAttribute('data-q') || '').includes(q)
      })
    })
  }

  var search = document.getElementById('nav-search')
  if (search) {
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase()
      document.querySelectorAll('[data-nav]').forEach(function (a) {
        var hit = !q || (a.textContent || '').toLowerCase().includes(q)
        a.hidden = !hit
      })
    })
  }

  var themeBtn = document.getElementById('theme-btn')
  function applyTheme(v) {
    if (v) document.documentElement.setAttribute('data-theme', v)
    else document.documentElement.removeAttribute('data-theme')
  }
  try { applyTheme(localStorage.getItem('metis-operator-theme')) } catch (e) {}
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme')
      var next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark'
      applyTheme(next)
      try {
        if (next) localStorage.setItem('metis-operator-theme', next)
        else localStorage.removeItem('metis-operator-theme')
      } catch (e) {}
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
      var f = b.getAttribute('data-crm-filter')
      document.querySelectorAll('#crm-table tbody tr').forEach(function (tr) {
        tr.hidden = f !== 'all' && tr.getAttribute('data-status') !== f
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

  var keyMsg = document.getElementById('key-msg')
  function showKey(j) {
    if (!keyMsg) return
    if (j && j.ok) keyMsg.textContent = j.last4 ? ('saved ··' + j.last4) : (j.status || 'ok')
    else keyMsg.textContent = (j && j.error) || 'failed'
  }

  function bindKeyAdd(form) {
    if (!form) return
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      var fd = new FormData(form)
      var j = await api('/v1/admin/keys', {
        provider: fd.get('provider'),
        label: fd.get('label'),
        secret: fd.get('secret')
      })
      if (j && j.ok) location.reload()
      else showKey(j)
    })
  }
  bindKeyAdd(document.getElementById('key-add'))
  bindKeyAdd(document.getElementById('key-add-settings'))

  var cfForm = document.getElementById('cf-add')
  if (cfForm) {
    cfForm.addEventListener('submit', async function (e) {
      e.preventDefault()
      var fd = new FormData(cfForm)
      var j = await api('/v1/admin/keys', {
        provider: 'cloudflare-account',
        accountId: fd.get('accountId'),
        token: fd.get('token')
      })
      if (j && j.ok) location.reload()
      else showKey(j)
    })
  }

  document.querySelectorAll('[data-rotate]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var secret = window.prompt('New secret or token')
      if (!secret) return
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-rotate') + '/rotate', { secret: secret })
      if (j && j.ok) location.reload()
      else showKey(j)
    })
  })

  document.querySelectorAll('[data-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-revoke') + '/revoke', {})
      if (j && j.ok) location.reload()
      else showKey(j)
    })
  })
})();
`
