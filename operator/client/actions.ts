/**
 * Seat detail overlay plus every mutation handler: key add/rotate/revoke, skill
 * reveal/approve/reject/push/draft, and CRM retry. Every mutation goes through `api()` and
 * reloads the page on success, matching the server-rendered-first-paint model (D3/D4 will
 * replace `location.reload()` with in-place re-render).
 */
import { api, looksLikeAccessHtml } from './api'

function addSeatField(body: HTMLElement, label: string, value: string, wide?: boolean): HTMLElement {
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

function fillSeatOverlay(row: HTMLElement): void {
  var overlay = document.getElementById('seat-overlay')
  if (!overlay) return
  overlay.hidden = false
  var title = overlay.querySelector('[data-drawer-title]')
  var no = overlay.querySelector('[data-seat-no]')
  var body = overlay.querySelector('[data-drawer-body]') as HTMLElement | null
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
  statusField.querySelector('.val')!.appendChild(pill)
  var meterField = addSeatField(body, 'Heartbeat', '', true)
  var meter = document.createElement('div')
  meter.className = 'seat-meter'
  var fill = document.createElement('i')
  fill.style.width = (row.getAttribute('data-seat-meter') || '8') + '%'
  meter.appendChild(fill)
  meterField.querySelector('.val')!.appendChild(meter)
  var barsField = addSeatField(body, 'Heartbeat bars', '', true)
  var hbars = document.createElement('div')
  hbars.className = 'seat-hbars'
  ;(row.getAttribute('data-seat-bars') || '8').split(',').forEach(function (n) {
    var bar = document.createElement('i')
    var v = Math.max(8, Math.min(100, parseInt(n, 10) || 8))
    bar.style.height = v + '%'
    hbars.appendChild(bar)
  })
  barsField.querySelector('.val')!.appendChild(hbars)
  var recent = row.getAttribute('data-seat-recent') || ''
  addSeatField(body, 'Recent', recent || 'No recent heartbeats for this seat.', true)
}

export function initSeatOverlay(): void {
  document.querySelectorAll<HTMLElement>('[data-seat-row]').forEach(function (row) {
    row.addEventListener('click', function () {
      fillSeatOverlay(row)
    })
  })
  var seatClose = document.getElementById('seat-overlay-close')
  if (seatClose) {
    seatClose.addEventListener('click', function () {
      var overlay = document.getElementById('seat-overlay')
      if (overlay) overlay.hidden = true
    })
  }
}

export function initSkillActions(): void {
  document.querySelectorAll<HTMLElement>('[data-reveal]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reveal')
      var j = await api('/v1/admin/asks/' + id)
      document.getElementById('reveal')!.textContent = j.ok ? j.question || '(empty)' : j.error || 'reveal failed'
    })
  })

  document.querySelectorAll<HTMLElement>('[data-approve]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-approve')
      var diff = (document.querySelector('[data-diff="' + id + '"]') as HTMLInputElement).value
      await api('/v1/admin/skills/' + id + '/approve', { diff: diff })
      location.reload()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-reject]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reject')
      await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
      location.reload()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-push]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-push')
      await api('/v1/admin/skills/' + id + '/push', {})
      location.reload()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-draft]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
      location.reload()
    })
  })
}

export function initCrmRetry(): void {
  document.querySelectorAll<HTMLElement>('[data-retry]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/crm/' + b.getAttribute('data-retry') + '/retry', {})
      location.reload()
    })
  })
}

function showKey(el: HTMLElement | null, j: any): void {
  if (!el) return
  if (j && j.ok) {
    el.className = 'key-msg ok'
    el.textContent = j.last4 ? 'saved ··' + j.last4 : j.status || 'ok'
  } else {
    el.className = 'key-msg fail-loud'
    var err = (j && j.error) || 'Add failed'
    if (err === 'Access required' || looksLikeAccessHtml(err)) {
      err = 'Access required. Sign in with Cloudflare Access and retry Add.'
    }
    el.textContent = err
  }
}

function bindKeyAdd(form: HTMLFormElement | null, msgId?: string): void {
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

export function initKeyForms(): void {
  bindKeyAdd(document.getElementById('key-add') as HTMLFormElement | null, 'key-msg')
  bindKeyAdd(document.getElementById('key-add-settings') as HTMLFormElement | null, 'key-msg-settings')

  document.querySelectorAll<HTMLElement>('[data-rotate]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var secret = window.prompt('New secret or token')
      if (!secret) return
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-rotate') + '/rotate', { secret: secret })
      if (j && j.ok) location.reload()
      else showKey(document.getElementById('key-msg'), j)
    })
  })

  document.querySelectorAll<HTMLElement>('[data-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-revoke') + '/revoke', {})
      if (j && j.ok) location.reload()
      else showKey(document.getElementById('key-msg'), j)
    })
  })
}
