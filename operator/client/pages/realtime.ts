/**
 * Realtime page client init. Wires ../../src/world/map-dom.ts's `attachMapInteraction` onto
 * the map root operator/src/render/pages/realtime.ts renders (plan 6.3: "attachMapInteraction
 * from world/map-dom.ts finally wired") — zoom/pan, hover-fade, the tooltip, the live beacon
 * and the first-paint draw-in all start working the moment this section exists in the DOM.
 * Whatever OTHER client-side wiring the Realtime page needs still lives in
 * operator/client/{filters,actions,licenses}.ts, called from operator/client/main.ts's
 * reinitPage() — this file only owns the map, per the plan's "each page owns exactly one file
 * here" rule.
 *
 * Called with the page's own `[data-page="realtime"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint (the
 * section is already server-rendered, there is no freshly fetched payload yet).
 */
import type { DashboardPayload } from '../../src/dashboard'
import { attachMapInteraction, type MapInteractionHandle } from '../../src/world/map-dom'
import { MAP_DIMENSIONS } from '../../src/world/mercator'

let handle: MapInteractionHandle | null = null

export function initRealtime(section: HTMLElement, data: DashboardPayload | null): void {
  void data
  // A rerender() replaces the section's innerHTML with a fresh map root; the previous
  // handle's listeners point at nodes that no longer exist in the document, so it is torn
  // down before binding the new one rather than leaking a stale listener set per refresh.
  handle?.destroy()
  handle = null
  const root = section.querySelector<HTMLElement>('[data-map-root]')
  if (!root) return
  const { width, height } = MAP_DIMENSIONS['1152']
  handle = attachMapInteraction(root, { width, height })
}
