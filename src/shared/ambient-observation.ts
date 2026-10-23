/**
 * ambient-observation.ts — Settings › Privacy disclosure of what Métis observes in the background (R111, D-19).
 *
 * One row per ambient signal: what it reads, what turns it on, and what it keeps. The foreground app watcher is a
 * transient in-memory trigger with no persisted history; src/main/foreground-watcher.privacy.contract.test.ts and
 * the audit tests in src/main/screen-preprocess.test.ts hold the code to this copy.
 */
export interface AmbientObservationRow {
  id: 'foreground-app'
  label: string
  /** What it reads and when it runs. */
  detail: string
  /** What it keeps. Plain words, no jargon. */
  keeps: string
}

export const AMBIENT_OBSERVATION_ROWS: readonly AmbientObservationRow[] = [
  {
    id: 'foreground-app',
    label: 'Which app is in front',
    detail:
      'Used only to refresh the optional on-device screen reader when you switch apps, and to check that a voice action reached the right app. It does not run while both are off.',
    keeps: 'Held in memory only. Never saved, logged, sent or reported, and only the latest app is remembered.'
  }
] as const
