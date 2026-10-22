/**
 * Licenses page client init. Whatever approve/revoke/generate wiring the page needs still lives in
 * operator/client/licenses.ts (called from operator/client/main.ts); this adds the Source filter (O05):
 * a `[data-source-filter]` select hides the seat rows whose `data-source` differs and shows the
 * "no seats from this source" line when nothing is left. It queries the DOM fresh on each call, so it
 * re-attaches cleanly after a rerender() replaces the section.
 *
 * Called with the page's own `[data-page="licenses"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint.
 */
import type { DashboardPayload } from '../../src/dashboard'

export function initLicenses(section: HTMLElement, data: DashboardPayload | null): void {
  void data
  var select = section.querySelector<HTMLSelectElement>('[data-source-filter]')
  if (!select) return
  var empty = section.querySelector<HTMLElement>('[data-source-filter-empty]')
  var apply = function (): void {
    var want = select ? select.value : ''
    var shown = 0
    section.querySelectorAll<HTMLElement>('tr[data-device][data-source]').forEach(function (row) {
      var hit = !want || row.getAttribute('data-source') === want
      row.hidden = !hit
      if (hit) shown += 1
    })
    if (empty) empty.hidden = shown > 0
  }
  select.addEventListener('change', apply)
  apply()
}
