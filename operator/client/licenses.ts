/** License approve/revoke actions -- the two mutations genuinely shared across pages. Every
 * mutation goes through `api()`; both re-render the current page section in place through
 * `rerender()` (operator/client/main.ts, plan P0.4: never a full document reload) with a toast
 * reporting the outcome -- `data-license-approve` lives on both Overview (pending seats) and
 * Licenses, so this always refreshes whichever page the click happened on, not a hardcoded one.
 *
 * `data-license-revoke` is used two ways on the Licenses page (plan 6.7): revoking a seat's
 * approval (id = device id, row carries `data-device`) and revoking an issued license (id = jti,
 * row carries `data-license-jti`, operator/src/render/pages/licenses.ts). Overview never renders
 * this attribute, so the confirm + optimistic dot/dim transition below only ever runs there.
 *
 * Revoke confirms inline on the button itself (QA finding: matching the pattern plan 6.7 states
 * for the "Needs your review" block, "confirm inline in the row, never a modal") rather than
 * `window.confirm` -- the first click arms it ("Confirm revoke", 4s auto-revert), the second
 * click actually calls the API. The same two-click shape operator/client/pages/licenses.ts's own
 * Block 0 Revoke buttons use, kept as its own small copy here rather than a cross-file import
 * (the same choice this codebase already makes for the equivalent helper on the Sessions page).
 *
 * Generate and the once-string strip are NOT here, on purpose. Two different pages render a
 * "Generate license" form (Overview, plan 6.2; Licenses, plan 6.7), each with its own page-scoped
 * client init (operator/client/pages/overview.ts, operator/client/pages/licenses.ts) that binds
 * its own submit and Copy handlers directly to its own section. This file used to also carry a
 * global `document.querySelectorAll('[data-license-generate]')` / `[data-license-once-copy]`
 * handler pair, bound once at boot and again every time `reinitPage('licenses')` ran (operator/
 * client/main.ts) -- since Overview's own Generate form also carries `data-license-generate` (the
 * two pages happened to share that attribute name before Licenses moved to its own `data-licenses-
 * generate-form`), that global handler was a second, undeclared listener on Overview's form: every
 * click there minted two licenses and raced two toasts, exactly the double-bind Overview's own
 * file header already warned about. Removing it here (rather than teaching it to skip Overview,
 * or scoping it to `[data-page="licenses"]`) leaves each page owning its own generate flow fully,
 * with nothing shared left to accidentally double-bind against. */
import { api } from './api'
import { currentPage, rerender } from './main'
import { toast } from './toasts'
import { press } from './motion'

/** Swaps the row's status dot to the revoked look immediately (plan 3.5b: "the row's status dot
 *  turns red with a 200ms colour transition and the row dims"), before the API call resolves --
 *  the transition itself is a CSS rule scoped to this page (operator/src/spa/css-licenses.ts:
 *  `.status-dot i { transition: background-color 200ms var(--ease-color) }`), so this only needs
 *  to change which state class is applied and let the browser animate between them. A failed
 *  revoke restores the row (see the catch-path below), never leaving it stuck in a state the
 *  server does not actually hold. */
function markRevokedOptimistically(row: HTMLElement): { undo: () => void } {
  const dot = row.querySelector<HTMLElement>('.status-dot')
  const previousClass = dot ? dot.className : null
  const label = dot ? dot.querySelector('span') : null
  const previousLabel = label ? label.textContent : null
  row.classList.add('is-revoking')
  if (dot) dot.className = 'status-dot status-dot-revoked'
  if (label) label.textContent = 'Revoked'
  return {
    undo: function () {
      row.classList.remove('is-revoking')
      if (dot && previousClass !== null) dot.className = previousClass
      if (label && previousLabel !== null) label.textContent = previousLabel
    }
  }
}

/** Two-click inline confirm (never `window.confirm`): the first click arms the button, the
 *  second (within 4s) runs `onConfirm`. Auto-reverts so an armed Revoke never sits waiting
 *  indefinitely if the operator changes their mind and clicks elsewhere instead. */
function armConfirmButton(el: HTMLElement, onConfirm: () => void | Promise<void>): void {
  const original = el.textContent || 'Revoke'
  let confirming = false
  let revert: ReturnType<typeof setTimeout> | null = null
  el.addEventListener('click', () => {
    if (!confirming) {
      confirming = true
      el.textContent = 'Confirm revoke'
      el.classList.add('is-confirming')
      revert = setTimeout(() => {
        confirming = false
        el.textContent = original
        el.classList.remove('is-confirming')
      }, 4000)
      return
    }
    if (revert) clearTimeout(revert)
    confirming = false
    el.textContent = original
    el.classList.remove('is-confirming')
    void onConfirm()
  })
}

export function initLicenseActions(): void {
  document.querySelectorAll<HTMLElement>('[data-license-approve]').forEach(function (b) {
    press(b)
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
    press(b)
    armConfirmButton(b, async function () {
      var row = b.closest('tr')
      var isLicense = !!(row && row.hasAttribute('data-license-jti'))
      var restore = row instanceof HTMLElement ? markRevokedOptimistically(row) : null
      var j = await api('/v1/admin/licenses/' + encodeURIComponent(b.getAttribute('data-license-revoke') || '') + '/revoke', {})
      if (j && j.ok) {
        toast({ kind: 'ok', text: isLicense ? 'License revoked.' : 'Seat revoked.' })
        rerender(currentPage())
      } else {
        if (restore) restore.undo()
        toast({ kind: 'error', text: (j && j.error) || 'Could not revoke.' })
      }
    })
  })
}
