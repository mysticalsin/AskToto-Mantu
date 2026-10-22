/**
 * Return guard for the voice-action confirmation card (owner decision D-10).
 *
 * The card takes focus while the person may still be typing in another app. A Return that was already held when
 * the card appeared, an auto-repeat of it, or a Return inside the first 300 ms must never confirm. Everything is
 * clock-injected so the rule is tested without timers. The main process enforces the same delay independently
 * (`CommandControl.minConfirmDelayMs`), so a renderer that skipped this guard still cannot confirm early.
 */
export const COMMAND_RETURN_GUARD_MS = 300

export type ReturnGuardKey = { key: string; repeat?: boolean; isComposing?: boolean }

export interface ReturnGuard {
  /** True only for a fresh, non-repeating Return pressed at least 300 ms after the card appeared. */
  acceptsReturn(event: ReturnGuardKey): boolean
  /**
   * A pointer click always counts. A click the keyboard synthesised (`detail` 0: Return or Space on a focused
   * button) is held to the same window, because the native button would otherwise bypass the Return check.
   */
  acceptsClick(event: { detail: number }): boolean
}

export function createReturnGuard(options: { now?: () => number; guardMs?: number } = {}): ReturnGuard {
  const now = options.now ?? Date.now
  const guardMs = options.guardMs ?? COMMAND_RETURN_GUARD_MS
  const shownAt = now()
  const armed = (): boolean => now() - shownAt >= guardMs
  return {
    acceptsReturn: (event) => event.key === 'Enter' && event.repeat !== true && event.isComposing !== true && armed(),
    acceptsClick: (event) => event.detail > 0 || armed()
  }
}
