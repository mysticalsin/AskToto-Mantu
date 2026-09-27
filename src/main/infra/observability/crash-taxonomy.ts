import type { ObservabilityDetail } from './projection'

/**
 * INV-CRASH-TAXONOMY: crash records use one shared kind vocabulary; recoveryStatus means:
 * continued = skipped work and kept booting; retry_pending = next reveal retries; safe_start = skip brain resume.
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
export const RECOVERY_STATUSES = ['continued', 'retry_pending', 'safe_start'] as const

/** The app.crash detail for `kind`; `fatal` is decided here and nowhere else (B3-RC1). */
export function crashDetail(
  _kind: CrashKind,
  _facts: Omit<ObservabilityDetail<'app.crash'>, 'kind' | 'fatal'> = {}
): ObservabilityDetail<'app.crash'> {
  // Scaffolding: the real fatal-kind decision logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
