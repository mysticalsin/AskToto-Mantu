/**
 * Realtime page client init. Binds Mission Control map zoom/pan + theme paint on first paint
 * and after rerender(). Shared reinitPage() in main.ts still calls the same helpers so hash
 * navigation and mutations stay interactive.
 */
import type { DashboardPayload } from '../../src/dashboard'
import { initRealtimeMap, paintRealtimeMapTheme } from '../realtime-map'

export function initRealtime(section: HTMLElement, data: DashboardPayload | null): void {
  void section
  void data
  initRealtimeMap()
  paintRealtimeMapTheme()
}
