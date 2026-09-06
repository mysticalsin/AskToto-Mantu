/**
 * Seat detail overlay plus every mutation handler: key add/rotate/revoke, skill
 * reveal/approve/reject/push/draft, and CRM retry. Every mutation goes through `api()` and,
 * plan P0.4, re-renders the affected page section in place through `rerender()`
 * (operator/client/main.ts) instead of reloading the whole document, with a toast reporting the
 * outcome. Key rotation uses the masked `dialog()` primitive (operator/src/render/
 * primitives.ts) instead of a native browser prompt.
 */
import { api, looksLikeAccessHtml } from './api'
import { currentPage, rerender } from './main'
import { toast } from './toasts'

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

function afterMutation(ok: boolean, okText: string, failText: string, page: string, requestId?: string): void {
  if (ok) {
    toast({ kind: 'ok', text: okText })
    rerender(page)
  } else {
    toast({ kind: 'error', text: failText, requestId: requestId })
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
      var j = await api('/v1/admin/skills/' + id + '/approve', { diff: diff })
      afterMutation(!!(j && j.ok), 'Skill approved.', (j && j.error) || 'Could not approve the skill.', currentPage())
    })
  })

  document.querySelectorAll<HTMLElement>('[data-reject]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-reject')
      var j = await api('/v1/admin/skills/' + id + '/reject', { reason: 'rejected in console' })
      afterMutation(!!(j && j.ok), 'Skill rejected.', (j && j.error) || 'Could not reject the skill.', currentPage())
    })
  })

  document.querySelectorAll<HTMLElement>('[data-push]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var id = b.getAttribute('data-push')
      var j = await api('/v1/admin/skills/' + id + '/push', {})
      afterMutation(!!(j && j.ok), 'Skill pushed.', (j && j.error) || 'Could not push the skill.', currentPage())
    })
  })

  document.querySelectorAll<HTMLElement>('[data-draft]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/skills/draft', { skillId: b.getAttribute('data-draft') })
      afterMutation(!!(j && j.ok), 'Draft created.', (j && j.error) || 'Could not draft the skill.', currentPage())
    })
  })
}

export function initCrmRetry(): void {
  document.querySelectorAll<HTMLElement>('[data-retry]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/crm/' + b.getAttribute('data-retry') + '/retry', {})
      afterMutation(!!(j && j.ok), 'Retry queued.', (j && j.error) || 'Could not queue the retry.', currentPage())
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
    if (j && j.ok) {
      toast({ kind: 'ok', text: 'Key added.' })
      rerender('keys')
    }
  })
}

/** Plan 9 (no native browser prompt): the masked `dialog()` primitive (operator/src/render/
 * primitives.ts), rendered once per page by operator/src/render/pages/keys.ts as
 * `#rotate-key-dialog`. Wired once here (idempotent via `dialogWired`, since `initKeyForms()`
 * re-runs after every Keys page rerender()) with the target key id kept in a closure variable
 * set when a `[data-rotate]` button opens it. */
let dialogWired = false
let rotateTargetId: string | null = null

function wireRotateDialog(): void {
  if (dialogWired) return
  var overlay = document.getElementById('rotate-key-dialog')
  if (!overlay) return
  dialogWired = true
  var input = overlay.querySelector<HTMLInputElement>('.dialog-input')
  var reveal = overlay.querySelector<HTMLElement>('[data-dialog-reveal]')
  var cancel = overlay.querySelector<HTMLElement>('[data-dialog-cancel]')
  var confirm = overlay.querySelector<HTMLElement>('[data-dialog-confirm]')

  function close(): void {
    overlay!.hidden = true
    rotateTargetId = null
    if (input) input.value = ''
  }

  if (reveal) {
    reveal.addEventListener('click', function () {
      if (!input) return
      var showing = reveal!.getAttribute('aria-pressed') === 'true'
      input.type = showing ? 'password' : 'text'
      reveal!.setAttribute('aria-pressed', showing ? 'false' : 'true')
      reveal!.textContent = showing ? 'Show' : 'Hide'
    })
  }
  if (cancel) cancel.addEventListener('click', close)
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && overlay && !overlay.hidden) close()
  })
  if (confirm) {
    confirm.addEventListener('click', async function () {
      var secret = input ? input.value.trim() : ''
      var id = rotateTargetId
      if (!secret || !id) return
      var j = await api('/v1/admin/keys/' + id + '/rotate', { secret: secret })
      close()
      if (j && j.ok) {
        toast({ kind: 'ok', text: 'Key rotated.' })
        rerender('keys')
      } else {
        showKey(document.getElementById('key-msg'), j)
        toast({ kind: 'error', text: (j && j.error) || 'Could not rotate the key.' })
      }
    })
  }
}

export function initKeyForms(): void {
  bindKeyAdd(document.getElementById('key-add') as HTMLFormElement | null, 'key-msg')
  bindKeyAdd(document.getElementById('key-add-settings') as HTMLFormElement | null, 'key-msg-settings')

  wireRotateDialog()
  document.querySelectorAll<HTMLElement>('[data-rotate]').forEach(function (b) {
    b.addEventListener('click', function () {
      var overlay = document.getElementById('rotate-key-dialog')
      if (!overlay) return
      rotateTargetId = b.getAttribute('data-rotate')
      overlay.hidden = false
      var input = overlay.querySelector<HTMLInputElement>('.dialog-input')
      if (input) input.focus()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/keys/' + b.getAttribute('data-revoke') + '/revoke', {})
      if (j && j.ok) {
        toast({ kind: 'ok', text: 'Key revoked.' })
        rerender('keys')
      } else {
        showKey(document.getElementById('key-msg'), j)
        toast({ kind: 'error', text: (j && j.error) || 'Could not revoke the key.' })
      }
    })
  })
}
