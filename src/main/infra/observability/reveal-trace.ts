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

export function createRevealTrace(_opts: RevealTraceOptions): RevealTrace {
  // Scaffolding: the real reveal tracing state machine lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
