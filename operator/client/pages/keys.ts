/**
 * Keys page client init (plan 6.9, P1.7 brief). Add / Rotate / Revoke themselves stay exactly
 * where dev-shell already wired them, operator/client/actions.ts's `initKeyForms()` (called by
 * operator/client/main.ts on boot and after every `rerender('keys')`, a shared file this page does
 * not own): the `#key-add` form, the `#rotate-key-dialog` masked dialog and the `[data-rotate]` /
 * `[data-revoke]` buttons this module renders all use the exact ids and data attributes that code
 * already expects. Nothing here re-implements or duplicates that mutation logic.
 *
 * This file owns only what actions.ts does not provide and this page's own markup needs:
 *  - the grouped provider select's one-line-per-provider help text (show the one matching the
 *    current selection),
 *  - the Add form's masked-secret reveal toggle (actions.ts's reveal toggle lives inside the
 *    Rotate dialog only),
 *  - the vault table's "Show history" disclosure for superseded/revoked rows,
 *  - an explicit confirm step in front of `[data-revoke]` (plan lock 6 / this task's brief:
 *    "Revoke with confirm" -- actions.ts's existing handler fires on click with no confirmation;
 *    `window.confirm()` ahead of it is the same pattern operator/client/pages/groups.ts,
 *    operator/client/pages/notifications.ts and operator/client/licenses.ts already use for every
 *    other revoke-style action in this app),
 *  - the two plan 3.5b motion lines actions.ts's generic wiring has no hook for: the Rotate
 *    dialog's open animation, and the Add result line's slide-in,
 *  - `patchVaultTable()`, an exported scoped-patch path for the vault `<tbody>` that
 *    actions.ts's Add/Rotate/Revoke success handlers should call instead of a whole-section
 *    `rerender('keys')` (plan 3.5b: "the new row inserts with FLIP") -- see this task's final
 *    report for the small actions.ts patch that wires it in.
 *
 * All wiring here is delegated to the page's own `[data-page="keys"]` section (attached once, see
 * wireOnce()) rather than to the individual buttons/inputs the server (or a rerender()) redraws,
 * so it keeps working across every `rerender('keys')` without needing to be re-run itself --
 * unlike actions.ts's own per-element bindings, which operator/client/main.ts re-invokes on every
 * such rerender for exactly that reason. See this task's final report for related gaps in
 * actions.ts's Rotate dialog wiring (no exit animation on close, an uncrossfaded reveal toggle)
 * and for the `.eyebrow` "eyebrow label" pattern this page's card headers no longer use.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { renderHistoryToggle, renderVaultTable } from '../../src/render/pages/keys'
import { flash, flip, growBar, pop, reduceMotion, slideIn, staggerIn } from '../motion'

const WIRED_FLAG = 'keysWired'

// ---------------------------------------------------------------------------
// Provider select -> one-line help.
// ---------------------------------------------------------------------------

function showProviderHelp(section: HTMLElement, value: string): void {
  section.querySelectorAll<HTMLElement>('[data-provider-help]').forEach((p) => {
    p.hidden = p.getAttribute('data-provider-help') !== value
  })
}

function syncProviderHelp(section: HTMLElement): void {
  const select = section.querySelector<HTMLSelectElement>('#keys-add-provider')
  if (select) showProviderHelp(section, select.value)
}

// ---------------------------------------------------------------------------
// Add form secret reveal (plan 3.5b: "the masked input's reveal toggle crossfades the dots to
// text"). `.is-crossfading` (operator/src/spa/css-keys.ts) is a plain opacity transition timed to
// match these two setTimeout steps; reduced motion skips straight to the swap.
// ---------------------------------------------------------------------------

const CROSSFADE_MS = 90

function toggleSecretReveal(section: HTMLElement): void {
  const input = section.querySelector<HTMLInputElement>('#keys-add-secret')
  const btn = section.querySelector<HTMLElement>('#keys-add-reveal')
  if (!input || !btn) return
  const next = btn.getAttribute('aria-pressed') !== 'true'
  const swap = (): void => {
    input.type = next ? 'text' : 'password'
    btn.setAttribute('aria-pressed', next ? 'true' : 'false')
    btn.textContent = next ? 'Hide' : 'Show'
  }
  if (reduceMotion()) {
    swap()
    return
  }
  input.classList.add('is-crossfading')
  window.setTimeout(() => {
    swap()
    window.setTimeout(() => input.classList.remove('is-crossfading'), CROSSFADE_MS)
  }, CROSSFADE_MS)
}

// ---------------------------------------------------------------------------
// Vault "Show history" disclosure (superseded / revoked rows, plan 6.9).
// ---------------------------------------------------------------------------

function toggleHistory(section: HTMLElement, btn: HTMLElement): void {
  const rows = Array.from(section.querySelectorAll<HTMLElement>('[data-key-history-row]'))
  const next = btn.getAttribute('aria-expanded') !== 'true'
  rows.forEach((r) => {
    r.hidden = !next
  })
  btn.setAttribute('aria-expanded', next ? 'true' : 'false')
  btn.textContent = (next ? btn.getAttribute('data-hide-label') : btn.getAttribute('data-show-label')) || btn.textContent || ''
  if (next && !reduceMotion()) staggerIn(rows)
}

// ---------------------------------------------------------------------------
// Rotate dialog open animation (plan 3.5b: "scale + opacity open, spring close"). Observes the
// shared `#rotate-key-dialog`'s `hidden` attribute rather than hooking actions.ts's open/close
// code directly, so it keeps working regardless of which button or key press toggled it. A true
// close animation is not reachable from here: actions.ts's Cancel/Confirm handlers flip `hidden`
// to true synchronously with no delay, and `.dialog-overlay[hidden]` is `display: none` (not
// transitionable) in operator/src/spa/css.ts, a file this page does not own -- see this task's
// final report for the small patch that would add one.
// ---------------------------------------------------------------------------

let rotateDialogObserver: MutationObserver | null = null

function wireRotateDialogMotion(section: HTMLElement): void {
  if (rotateDialogObserver) {
    rotateDialogObserver.disconnect()
    rotateDialogObserver = null
  }
  const overlay = section.querySelector<HTMLElement>('#rotate-key-dialog')
  if (!overlay) return
  const panel = overlay.querySelector<HTMLElement>('.dialog-panel')
  if (!panel) return
  rotateDialogObserver = new MutationObserver(() => {
    if (!overlay.hidden) pop(panel)
  })
  rotateDialogObserver.observe(overlay, { attributes: true, attributeFilter: ['hidden'] })
}

// ---------------------------------------------------------------------------
// Add-key result line slide-in (plan 3.5b: "on Add the result line slides in"). Observes
// `#key-msg`, whose text/class actions.ts's showKey() sets directly.
// ---------------------------------------------------------------------------

let resultLineObserver: MutationObserver | null = null

function wireResultLineMotion(section: HTMLElement): void {
  if (resultLineObserver) {
    resultLineObserver.disconnect()
    resultLineObserver = null
  }
  const el = section.querySelector<HTMLElement>('#key-msg')
  if (!el) return
  resultLineObserver = new MutationObserver(() => {
    if (el.textContent && el.textContent.trim() && !reduceMotion()) slideIn(el, 'bottom')
  })
  resultLineObserver.observe(el, { childList: true, characterData: true, subtree: true })
}

// ---------------------------------------------------------------------------
// Scoped vault table patch (plan 3.5b: "the new row inserts with FLIP"). Called from
// operator/client/actions.ts after a successful Add/Rotate/Revoke in place of a whole-section
// rerender('keys') -- see this task's final report for the small patch that wires that call, a
// file this page does not own. Re-renders only the `<tbody>` (via renderVaultTable(), this
// page's own export) and FLIP-animates it into place (motion.ts's flip(), unchanged), so only the
// inserted/changed row moves instead of every row on the table re-staggering. Everything else in
// the Keys section (Add form, Funded providers, Cloudflare card) is left exactly as it was --
// those can still go one refresh stale until the next full page load, the same trade-off the
// design gate's own fix suggestion accepts for this pattern.
// ---------------------------------------------------------------------------

function extractFreshTbody(tableHtml: string): HTMLElement | null {
  const template = document.createElement('template')
  template.innerHTML = tableHtml
  return template.content.querySelector<HTMLElement>('#vault-table tbody')
}

/** Keeps the "Show history" toggle's count in sync with a patched table without touching
 *  anything else in the card head. A Rotate or Revoke can move `historyCount` from 0 to 1 (the
 *  vault's first-ever superseded/revoked row), a transition the toggle never renders for on its
 *  own (renderHistoryToggle(0) returns ''); this inserts the button fresh for exactly that case,
 *  otherwise it only updates the existing button's stored/shown label. */
function syncHistoryToggle(section: HTMLElement, historyCount: number): void {
  const existing = section.querySelector<HTMLElement>('[data-keys-history-toggle]')
  if (existing) {
    existing.setAttribute('data-show-label', `Show history (${historyCount})`)
    if (existing.getAttribute('aria-expanded') !== 'true') existing.textContent = `Show history (${historyCount})`
    return
  }
  if (historyCount <= 0) return
  const head = section.querySelector<HTMLElement>('[data-keys-vault-card] .keys-card-head')
  if (!head) return
  const template = document.createElement('template')
  template.innerHTML = renderHistoryToggle(historyCount)
  const btn = template.content.firstElementChild
  if (btn) head.appendChild(btn)
}

/**
 * Patches the vault `<tbody>` in place from a freshly fetched `DashboardPayload`, FLIP-animating
 * only the rows that actually moved or were inserted. Returns `false` when there is no live table
 * to patch -- the vault was empty and dataTable() rendered emptyState() instead of a `<table>` --
 * so the caller can fall back to a full `rerender('keys')` for that one case.
 */
export function patchVaultTable(section: HTMLElement, data: DashboardPayload): boolean {
  const table = section.querySelector<HTMLTableElement>('#vault-table')
  const tbody = table?.querySelector<HTMLElement>('tbody')
  if (!table || !tbody) return false
  const { html, historyCount } = renderVaultTable(data, Date.now())
  const freshTbody = extractFreshTbody(html)
  if (!freshTbody) return false
  const freshRows = Array.from(freshTbody.children)
  flip(tbody, () => {
    tbody.replaceChildren(...freshRows)
  })
  // flip() only replays position/fade for rows it can see moved or arrived; it never reads the
  // data-pop / data-grow / data-flash-key hooks dataTable() also renders (motion-bind.ts's job
  // normally), and bindMotion(tbody) is deliberately not called here -- every existing row also
  // carries data-stagger, so a wholesale bind would re-stagger the whole table on every mutation,
  // exactly what this scoped patch exists to avoid. Instead this fires the three hooks that only
  // ever apply to the one row renderVaultTable() marks "keys-vault-top" (plan 3.5b: "provider logo
  // glyphs fade in", "usage bars ... grow on load", "the new row inserts with FLIP and an accent
  // wash") -- each helper already no-ops correctly under reduced motion on its own.
  const topRow = tbody.querySelector<HTMLElement>('[data-flash-key="keys-vault-top"]')
  if (topRow) {
    flash(topRow)
    topRow.querySelectorAll<HTMLElement>('[data-pop]').forEach((el) => pop(el))
    topRow.querySelectorAll<HTMLElement>('[data-grow]').forEach((el) => growBar(el, 400, 0))
  }
  syncHistoryToggle(section, historyCount)
  return true
}

// ---------------------------------------------------------------------------
// Delegated, bind-once wiring (see file doc comment: survives every rerender('keys') untouched).
// ---------------------------------------------------------------------------

function wireOnce(section: HTMLElement): void {
  if (section.dataset[WIRED_FLAG] === '1') return
  section.dataset[WIRED_FLAG] = '1'

  section.addEventListener('change', (e) => {
    const target = e.target
    if (target instanceof HTMLSelectElement && target.id === 'keys-add-provider') {
      showProviderHelp(section, target.value)
    }
  })

  section.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return
    const reveal = target.closest('#keys-add-reveal')
    if (reveal) {
      toggleSecretReveal(section)
      return
    }
    const historyToggle = target.closest<HTMLElement>('[data-keys-history-toggle]')
    if (historyToggle) toggleHistory(section, historyToggle)
  })

  // Capture phase: must run before actions.ts's bubble-phase [data-revoke] handler on the same
  // button (see file doc comment for why the confirm lives here rather than in that shared file).
  section.addEventListener(
    'click',
    (e) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const btn = target.closest<HTMLElement>('[data-revoke]')
      if (!btn) return
      const label = btn.getAttribute('data-revoke-provider') || 'this key'
      const ok = window.confirm(`Revoke the ${label} key? Seats using it will stop working immediately.`)
      if (!ok) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    },
    { capture: true }
  )
}

/**
 * Called with the page's own `[data-page="keys"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint. The
 * payload itself is unused here -- every behaviour this page owns reads the DOM the render module
 * already produced, not the wire shape directly.
 */
export function initKeys(section: HTMLElement, _data: DashboardPayload | null): void {
  syncProviderHelp(section)
  wireOnce(section)
  wireRotateDialogMotion(section)
  wireResultLineMotion(section)
}
