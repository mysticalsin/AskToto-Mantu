/**
 * island/metrics.ts — per-display notch/menu-bar metrics for the notch-aware top clamp (MQA-275, Phase 1
 * item 3 of the Métis × Vibe-Island rebuild). Priority order (docs/plans/metis-vibe-island-rebuild.plan.md
 * §2.4):
 *   1. `metis-mac-helper screen-metrics` (native/mac-helper/main.swift) — the real NSScreen notch/safe-area
 *      geometry, cached here and invalidated on display-topology changes.
 *   2. A heuristic fallback (`hasNotchHeuristic` in ./geometry) when the helper is missing/broken.
 *   3. Windows / non-darwin: always the heuristic path, which always reports `hasNotch: false` there.
 *
 * CRITICAL coordinate-space note: the helper's raw payload (mac-helper.ts's RawScreenMetric) carries
 * AppKit `NSScreen.frame`/`visibleFrame` — a BOTTOM-left-origin coordinate space. Electron's
 * `Display.bounds`/`Display.workArea` use a TOP-left-origin space (same as `BrowserWindow.setBounds`).
 * This module NEVER uses the helper's frame/visibleFrame for the DisplayMetrics it returns — only the
 * magnitude fields (`notchWidth`, `safeAreaInsetTop`), which are coordinate-space-independent. `bounds`/
 * `workArea` always come from the live Electron `Display` the caller passes in. Silently mixing the two
 * spaces would mis-position the window on any multi-display Mac — this is the one thing an on-Mac
 * reviewer must re-verify, since it cannot be exercised on this (non-macOS) development VM.
 *
 * The helper spawn is one-shot (~100ms) and only re-run after invalidation — never polled — so the hot
 * anchor/resize path (index.ts's anchorTopCenter/resizeTo, called on every reveal) is never blocked on a
 * subprocess: getDisplayMetrics() is synchronous and returns the heuristic immediately if the cache is
 * cold, kicking off a background fetch so the NEXT call is warm.
 */
import { powerMonitor, screen, type Display } from 'electron'
import { getMacScreenMetrics, type RawScreenMetric } from '../mac-helper'
import { mainLog } from '../logger'
import { hasNotchHeuristic, type DisplayMetrics } from './geometry'

let helperById: Map<number, RawScreenMetric> | null = null
let fetchInFlight: Promise<void> | null = null
// Distinct from `helperById === null` (which also means "helper absent/failed") — without this flag, a
// mac install with no helper binary (or one that keeps timing out) would re-spawn on EVERY single
// getDisplayMetrics() call forever, since a null result looks identical to "never tried yet".
let hasFetchedOnce = false

/** Kick off (or no-op into) a background screen-metrics fetch. Never awaited by a caller on the hot
 *  path — see the module header. A no-op once this display topology has already been fetched once
 *  (successfully or not), not just while a fetch is in flight — see `hasFetchedOnce`'s comment. */
function fetchHelperMetrics(): void {
  if (fetchInFlight || hasFetchedOnce || process.platform !== 'darwin') return
  fetchInFlight = getMacScreenMetrics()
    .then((raw) => {
      helperById = raw ? new Map(raw.map((m) => [m.displayID, m])) : null
    })
    .catch((e) => {
      mainLog.warn('[island/metrics] screen-metrics fetch failed', e instanceof Error ? e.message : String(e))
      helperById = null
    })
    .finally(() => {
      fetchInFlight = null
      hasFetchedOnce = true
    })
}

/** Drop the cached helper metrics so the next `getDisplayMetrics()` call re-fetches. Call on any
 *  display-topology change and on wake-from-sleep (a notch MacBook can wake docked to a different
 *  external display than it slept on). Exported for tests; `registerDisplayMetricsInvalidation()` wires
 *  it to the real Electron events for the app's lifetime. */
export function invalidateDisplayMetricsCache(): void {
  helperById = null
  fetchInFlight = null
  hasFetchedOnce = false
}

/** App-scoped listeners; live for the process lifetime (same pattern as index.ts's
 *  registerScreenListeners), so this is never unregistered. Idempotent to call more than once only in
 *  the sense that duplicate listeners would double-invalidate — call exactly once from boot. */
export function registerDisplayMetricsInvalidation(): void {
  screen.on('display-added', invalidateDisplayMetricsCache)
  screen.on('display-removed', invalidateDisplayMetricsCache)
  screen.on('display-metrics-changed', invalidateDisplayMetricsCache)
  powerMonitor.on('resume', invalidateDisplayMetricsCache)
}

/**
 * Best-effort, SYNCHRONOUS metrics for one display — safe to call from the hot anchor/resize path.
 * `display` only needs the three fields index.ts already has on hand from `screen.getDisplayMatching`.
 */
export function getDisplayMetrics(display: Pick<Display, 'id' | 'bounds' | 'workArea'>): DisplayMetrics {
  if (process.platform === 'darwin') {
    fetchHelperMetrics() // no-op once cached or already in flight; warms the cache for next time
    const helper = helperById?.get(display.id)
    if (helper) {
      return {
        bounds: display.bounds,
        workArea: display.workArea,
        hasNotch: helper.notchWidth > 0,
        notchWidth: helper.notchWidth,
        menuBarHeight: helper.safeAreaInsetTop,
        source: 'helper'
      }
    }
  }
  const menuBarHeight = display.bounds.height - display.workArea.height
  return {
    bounds: display.bounds,
    workArea: display.workArea,
    hasNotch: hasNotchHeuristic(menuBarHeight, process.platform),
    notchWidth: 0,
    menuBarHeight,
    source: 'heuristic'
  }
}
