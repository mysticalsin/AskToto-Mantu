/** License generate/approve/revoke actions. Every mutation goes through `api()`; approve/revoke
 * re-render the current page section in place through `rerender()` (operator/client/main.ts,
 * plan P0.4: never a full document reload) with a toast reporting the outcome -- `data-license-approve`
 * lives on both Overview (pending seats) and Licenses, so this always refreshes whichever page
 * the click happened on, not a hardcoded one. Generate patches the once-string box in place
 * without a reload so the string stays visible either way. */
import { api } from './api'
import { currentPage, rerender } from './main'
import { toast } from './toasts'

export function initLicenseActions(): void {
  document.querySelectorAll<HTMLElement>('[data-license-approve]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-approve') || '') + '/approve', {})
      if (j && j.ok) {
        toast({ kind: 'ok', text: 'Seat approved.' })
        rerender(currentPage())
      } else {
        toast({ kind: 'error', text: (j && j.error) || 'Could not approve the seat.' })
      }
    })
  })

  document.querySelectorAll<HTMLElement>('[data-license-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var j = await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-revoke') || '') + '/revoke', {})
      if (j && j.ok) {
        toast({ kind: 'ok', text: 'License revoked.' })
        rerender(currentPage())
      } else {
        toast({ kind: 'error', text: (j && j.error) || 'Could not revoke the license.' })
      }
    })
  })

  document.querySelectorAll<HTMLFormElement>('[data-license-generate]').forEach(function (form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault()
      var fd = new FormData(form)
      var j = await api('/v1/admin/licenses/generate', { days: Number(fd.get('days')) })
      var root = form.parentElement
      var box = root && root.querySelector('[data-license-once]')
      var input = root && (root.querySelector('[data-license-once-value]') as HTMLInputElement | null)
      if (j && j.ok && j.license && box && input) {
        input.value = j.license
        ;(box as HTMLElement).hidden = false
        toast({ kind: 'ok', text: 'License generated. Copy it now, it will not be shown again.' })
      } else if (!(j && j.ok)) {
        toast({ kind: 'error', text: (j && j.error) || 'Could not generate a license.' })
      }
    })
  })

  document.querySelectorAll<HTMLElement>('[data-license-once-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var root = btn.parentElement
      var input = root && (root.querySelector('[data-license-once-value]') as HTMLInputElement | null)
      if (input && input.value && navigator.clipboard) await navigator.clipboard.writeText(input.value)
    })
  })
}
