import type { AuditSink } from '../../logger'
import type { OverlayLayout } from '@shared/overlay-chrome'
import type { REVEAL_OUTCOMES, REVEAL_REASONS } from './projection'

export type RevealReason = (typeof REVEAL_REASONS)[number]
export type RevealOutcome = (typeof REVEAL_OUTCOMES)[number]

/** The only BrowserWindow methods a reveal snapshot reads. */
export interface RevealWindow {
  isDestroyed(): boolean
  isVisible(): boolean
}

export interface RevealTraceOptions {
  audit: AuditSink
  window: () => RevealWindow | null
  /** The live overlay layout; may throw before settings load, and the event then omits `layout`. */
  layout: () => OverlayLayout
  /** Whether the overlay is resting parked (Hide/Island rest state). */
  parked: () => boolean
  now?: () => number
}

export interface RevealTrace {
  /** Run `reveal` and audit what it did to the overlay window; returns its result or rethrows its error. */
  trace<T>(reason: RevealReason, reveal: () => T): T
}

type Snapshot = { live: boolean; visible: boolean; parked: boolean }

export function createRevealTrace(opts: RevealTraceOptions): RevealTrace {
  const now = opts.now ?? (() => performance.now())
  return {
    trace<T>(reason: RevealReason, reveal: () => T): T {
      const before = snapshot(opts.window(), opts.parked())
      let layout: OverlayLayout | undefined
      try {
        layout = opts.layout()
      } catch {
        /* layout is unavailable before settings load */
      }
      const startedAt = now()
      let thrown = false
      try {
        return reveal()
      } catch (error) {
        thrown = true
        throw error
      } finally {
        const after = snapshot(opts.window(), opts.parked())
        opts.audit('reveal', {
          reason,
          isVisible: before.visible,
          parked: before.parked,
          ...(layout !== undefined ? { layout } : {}),
          outcome: outcome(before, after, thrown),
          ms: Math.max(0, now() - startedAt)
        })
      }
    }
  }
}

function snapshot(window: RevealWindow | null, parked: boolean): Snapshot {
  const live = window !== null && !window.isDestroyed()
  return { live, visible: live && window.isVisible(), parked: live && parked }
}

function outcome(before: Snapshot, after: Snapshot, thrown: boolean): RevealOutcome {
  if (thrown || !after.live) return 'failed'
  if (!before.live) return 'created'
  if (before.parked && !after.parked) return 'shown'
  if (before.visible) return 'already-visible'
  if (after.visible) return 'shown'
  return 'failed'
}
