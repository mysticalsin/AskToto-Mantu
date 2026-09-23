/**
 * Realtime page client init. Binds the live map (zoom/pan, re-clustering, popover, in-place
 * `metis:live` repaint) on first paint and after rerender(). Shared reinitPage() in main.ts calls
 * the same helper so hash navigation and mutations stay interactive. Theme is CSS tokens only.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { initRealtimeMap } from '../realtime-map'

export function initRealtime(section: HTMLElement, data: DashboardPayload | null): void {
  void section
  void data
  initRealtimeMap()
}
