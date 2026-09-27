import type { ObservabilityDetail } from './projection'

/**
 * INV-CRASH-TAXONOMY: crash records use one shared kind vocabulary; recoveryStatus means:
 * continued = skipped work and kept booting; retry_pending = next reveal retries; safe_start = skip brain resume;
 * unrecovered = no further automatic action will run.
 */
export const CRASH_KINDS = [
  'uncaughtException',
  'unhandledRejection',
  'render-process-gone',
  'renderer-error-boundary',
  'boot-early-death',
  'boot'
] as const
export type CrashKind = (typeof CRASH_KINDS)[number]
export const RECOVERY_STATUSES = ['continued', 'retry_pending', 'safe_start', 'unrecovered'] as const

/** Kinds recorded after the failing process died: the renderer, or the previous main. */
const FATAL_KINDS: ReadonlySet<CrashKind> = new Set(['render-process-gone', 'boot-early-death'])

/** The app.crash detail for `kind`; `fatal` is decided here and nowhere else (B3-RC1). */
export function crashDetail(
  kind: CrashKind,
  facts: Omit<ObservabilityDetail<'app.crash'>, 'kind' | 'fatal'> = {}
): ObservabilityDetail<'app.crash'> {
  return { ...facts, kind, fatal: FATAL_KINDS.has(kind) }
}
