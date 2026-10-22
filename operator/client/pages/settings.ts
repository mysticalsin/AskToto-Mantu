/**
 * Settings page client init: the Enrolment panel (O05). Every control posts to an owner-only route
 * under /v1/admin (the Worker is the enforcement boundary; the panel only hides controls a non-owner
 * could not use). A generated token is shown once in the `[data-enroll-once]` box and is never kept
 * anywhere else: the section is re-rendered afterwards to refresh the list, and the box is re-opened
 * from the in-memory value for that single re-render only, then forgotten.
 *
 * Called with the page's own `[data-page="settings"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { api } from '../api'
import { currentPage, rerender } from '../main'
import { toast } from '../toasts'

var onceToken = ''

function showOnce(section: HTMLElement, token: string): void {
  var box = section.querySelector<HTMLElement>('[data-enroll-once]')
  var input = section.querySelector<HTMLInputElement>('[data-enroll-once-value]')
  if (!box || !input) return
  input.value = token
  box.hidden = false
}

export function initSettings(section: HTMLElement, data: DashboardPayload | null): void {
  void data
  var panel = section.querySelector<HTMLElement>('[data-enroll-panel]')
  if (!panel) return
  var msg = panel.querySelector<HTMLElement>('[data-enroll-msg]')
  var say = function (text: string): void {
    if (msg) msg.textContent = text
  }

  if (onceToken) {
    showOnce(section, onceToken)
    onceToken = ''
  }

  var settingsForm = panel.querySelector<HTMLFormElement>('[data-enroll-settings]')
  if (settingsForm) {
    settingsForm.addEventListener('submit', async function (e) {
      e.preventDefault()
      var fd = new FormData(settingsForm as HTMLFormElement)
      var j = await api('/v1/admin/settings/enroll', {
        ssoTier: String(fd.get('ssoTier') || ''),
        ssoMaxDevicesPerUser: Number(fd.get('ssoMaxDevicesPerUser'))
      })
      if (j && j.ok) {
        toast({ kind: 'ok', text: 'Enrolment settings saved.' })
        rerender(currentPage())
      } else {
        say((j && j.error) || 'Could not save the enrolment settings.')
        toast({ kind: 'error', text: (j && j.error) || 'Could not save the enrolment settings.' })
      }
    })
  }

  panel.querySelectorAll<HTMLElement>('[data-enroll-pause]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var pause = btn.getAttribute('data-enroll-pause') === 'true'
      var j = await api('/v1/admin/settings/enroll', { paused: pause })
      if (j && j.ok) {
        toast({ kind: 'ok', text: pause ? 'Enrolment paused.' : 'Enrolment resumed.' })
        rerender(currentPage())
      } else {
        toast({ kind: 'error', text: (j && j.error) || 'Could not change enrolment.' })
      }
    })
  })

  var createForm = panel.querySelector<HTMLFormElement>('[data-enroll-create]')
  if (createForm) {
    createForm.addEventListener('submit', async function (e) {
      e.preventDefault()
      var fd = new FormData(createForm as HTMLFormElement)
      var j = await api('/v1/admin/enroll-tokens', {
        label: String(fd.get('label') || ''),
        channel: String(fd.get('channel') || ''),
        expiresInDays: Number(fd.get('expiresInDays')),
        maxDevices: Number(fd.get('maxDevices')),
        dailyCap: Number(fd.get('dailyCap'))
      })
      if (j && j.ok && j.token) {
        showOnce(section, String(j.token))
        // Re-render to refresh the list, then re-open the once box from this one in-memory value.
        onceToken = String(j.token)
        toast({ kind: 'ok', text: 'Token generated. Copy it now, it will not be shown again.' })
        rerender(currentPage())
      } else {
        say((j && j.error) || 'Could not generate a token.')
        toast({ kind: 'error', text: (j && j.error) || 'Could not generate a token.' })
      }
    })
  }

  panel.querySelectorAll<HTMLElement>('[data-enroll-once-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var root = btn.parentElement
      var input = root && root.querySelector<HTMLInputElement>('[data-enroll-once-value]')
      if (input && input.value && navigator.clipboard) await navigator.clipboard.writeText(input.value)
    })
  })

  panel.querySelectorAll<HTMLElement>('[data-enroll-revoke]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var kid = btn.getAttribute('data-enroll-revoke') || ''
      var cascade = panel!.querySelector<HTMLInputElement>('[data-enroll-cascade="' + kid + '"]')
      var j = await api('/v1/admin/enroll-tokens/' + encodeURIComponent(kid) + '/revoke', {
        reason: 'revoked in the console',
        cascade: Boolean(cascade && cascade.checked)
      })
      if (j && j.ok) {
        toast({
          kind: 'ok',
          text: j.cascaded ? 'Token revoked. ' + j.cascaded + ' licences revoked with it.' : 'Token revoked.'
        })
        rerender(currentPage())
      } else {
        toast({ kind: 'error', text: (j && j.error) || 'Could not revoke the token.' })
      }
    })
  })
}
