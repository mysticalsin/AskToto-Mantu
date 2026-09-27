/**
 * reload-budget.ts — bounds how many times render-process-gone may auto-reload the overlay before
 * giving up and letting the caller show a real recovery surface instead of reloading forever (B3-RC2:
 * the handler reloaded unconditionally, with no counter, no ceiling, and no distinction between a real
 * crash and a clean exit).
 */

/** Electron's `RenderProcessGoneDetails.reason` (see electron.d.ts). */
export type RenderProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'

export type ReloadDecision =
  // Within budget — the caller should reload.
  | 'reload'
  // Budget exhausted for the current 60s window — the caller must stop auto-reloading and show a
  // recovery surface instead.
  | 'halt'
  // `reason === 'clean-exit'`: the content exited on purpose (exit code zero), not a crash. Reloading it
  // would fight whatever intentionally ended it (e.g. mid-quit); never counts against the budget.
  | 'ignore'

const MAX_RELOADS_PER_WINDOW = 3
const WINDOW_MS = 60_000
/** How long a reload's content must stay up past its own did-finish-load before the whole history is
 *  forgiven — a streak that genuinely recovered must not still be spent against a later, unrelated crash. */
const ALIVE_RESET_MS = 30_000

export interface ReloadBudget {
  /** Call from the render-process-gone handler. See ReloadDecision for what each result means. */
  onRenderProcessGone(reason: RenderProcessGoneReason): ReloadDecision
  /** Call from the did-finish-load handler of whatever content the caller just (re)loaded. */
  onDidFinishLoad(): void
}

export function createReloadBudget(now: () => number = Date.now): ReloadBudget {
  let reloadTimestamps: number[] = []
  let lastFinishedLoadAt: number | null = null

  return {
    onRenderProcessGone(reason): ReloadDecision {
      if (reason === 'clean-exit') return 'ignore'
      const t = now()
      if (lastFinishedLoadAt !== null && t - lastFinishedLoadAt >= ALIVE_RESET_MS) {
        reloadTimestamps = []
      }
      lastFinishedLoadAt = null
      const cutoff = t - WINDOW_MS
      reloadTimestamps = reloadTimestamps.filter((ts) => ts > cutoff)
      if (reloadTimestamps.length >= MAX_RELOADS_PER_WINDOW) return 'halt'
      reloadTimestamps.push(t)
      return 'reload'
    },
    onDidFinishLoad(): void {
      lastFinishedLoadAt = now()
    }
  }
}
