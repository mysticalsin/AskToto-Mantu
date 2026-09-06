/** License generate/approve/revoke actions. Ported from the pre-D3 inline `<script>` in
 * ui.ts (see plan D3: no inline script, this is the real client). Every mutation goes through
 * `api()`; approve/revoke reload the page (server-rendered snapshot model), generate patches
 * the once-string box in place without a reload so the string stays visible. */
import { api } from './api'

export function initLicenseActions(): void {
  document.querySelectorAll<HTMLElement>('[data-license-approve]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-approve') || '') + '/approve', {})
      location.reload()
    })
  })

  document.querySelectorAll<HTMLElement>('[data-license-revoke]').forEach(function (b) {
    b.addEventListener('click', async function () {
      await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-revoke') || '') + '/revoke', {})
      location.reload()
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
