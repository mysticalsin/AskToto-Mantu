/**
 * Connectors page client init (plan P0.4 prep, dev-shell). Empty for now: whatever client-side
 * wiring the Connectors page needs today still lives in operator/client/{filters,actions,licenses}.ts,
 * called from operator/client/main.ts's reinitPage(). The Connectors page owner moves that logic in
 * here (and deletes it from the shared files) when they take the page; until then this is a
 * documented no-op so no page builder ever has to touch a file another page owns.
 *
 * Called with the page's own `[data-page="connectors"]` section element and, on a rerender()
 * (operator/client/main.ts), the freshly fetched DashboardPayload; `null` at first paint (the
 * section is already server-rendered, there is no freshly fetched payload yet).
 */
import type { DashboardPayload } from '../../src/dashboard'

export function initConnectors(section: HTMLElement, data: DashboardPayload | null): void {
  void section
  void data
}
