/**
 * The Worker's nightly cron body (G81): retention first, then usage reconciliation for yesterday and today, so a
 * late-ingested Ask (or a restart that missed a run) heals on the next tick. Neither step may take the other down,
 * and no log line carries anything but `{t, ok, day, seats, drift, error}`.
 */
import type { D1DatabaseLike } from './d1'
import { utcMidnight } from './meters'
import { pruneRetention } from './retention'
import type { OperatorStore } from './store'
import { reconcileUsageDay } from './usage-reconcile'

const DAY_MS = 24 * 60 * 60 * 1000

export interface NightlyResult {
  retention: boolean
  reconciled: Array<{ day: number; ok: boolean; seats?: number; drift?: number; error?: string }>
}

export async function runNightly(
  store: OperatorStore,
  db: D1DatabaseLike | undefined,
  now: number,
  log: (line: Record<string, unknown>) => void = (line) => console.log(JSON.stringify(line))
): Promise<NightlyResult> {
  let retention = true
  try {
    const result = await pruneRetention(store, now, {}, { db })
    log({ t: 'retention', ...result })
  } catch {
    retention = false
    log({ t: 'retention', ok: false, error: 'retention failed' })
  }
  const reconciled: NightlyResult['reconciled'] = []
  for (const day of [utcMidnight(now) - DAY_MS, utcMidnight(now)]) {
    try {
      const res = await reconcileUsageDay(db, day, now)
      if (res.ok) {
        reconciled.push({ day, ok: true, seats: res.seats, drift: res.drift })
        log({ t: 'reconcile', ok: true, day, seats: res.seats, drift: res.drift })
      } else {
        reconciled.push({ day, ok: false, error: res.error })
        log({ t: 'reconcile', ok: false, day, error: res.error })
      }
    } catch {
      reconciled.push({ day, ok: false, error: 'reconcile failed' })
      log({ t: 'reconcile', ok: false, day, error: 'reconcile failed' })
    }
  }
  return { retention, reconciled }
}
