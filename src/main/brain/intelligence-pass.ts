/**
 * Update Intelligence — the explicit agent pass. The button is the only caller.
 * Never auto-send. See docs/design/INTELLIGENCE-UPDATE.md.
 */
import { getSettings } from '../store'
import { auditLog } from '../logger'
import { startBackfill, type BackfillStartResult } from './ingest'
import { INTELLIGENCE_PASS_NO_PROVIDER, pickIntelligencePassCandidates } from './intelligence-pass-route'

export type IntelligencePassStartResult = BackfillStartResult & {
  error?: string
  upToDate?: boolean
}

/**
 * Start one Intelligence pass from an explicit click. Local-first routing is stamped on each
 * queued job. This function is not called from boot, reconcile, consolidation, or a view mount.
 */
export function startIntelligencePass(): IntelligencePassStartResult {
  const s = getSettings()
  if (pickIntelligencePassCandidates(s).length === 0) {
    return { queued: 0, error: INTELLIGENCE_PASS_NO_PROVIDER }
  }
  const result = startBackfill(undefined, { route: 'intelligence-pass' })
  if (result.deferred === 'no-provider') {
    return { queued: 0, error: INTELLIGENCE_PASS_NO_PROVIDER }
  }
  auditLog('brain.intelligencePass.start', { queued: result.queued, preparing: result.preparing === true })
  if (result.queued === 0 && !result.preparing) return { ...result, upToDate: true }
  return result
}
