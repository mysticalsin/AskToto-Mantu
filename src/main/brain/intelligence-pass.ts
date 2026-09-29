/**
 * Update Intelligence — the explicit agent pass. The button is the only caller.
 * Never auto-send. See docs/design/INTELLIGENCE-UPDATE.md.
 */
import { getSettings } from '../store'
import { auditLog } from '../logger'
import { startBackfill, type BackfillStartHandle, type BackfillStartResult } from './ingest'
import { INTELLIGENCE_PASS_NO_PROVIDER, pickIntelligencePassCandidates } from './intelligence-pass-route'
import { intelligenceNoProviderMessage } from '@shared/intelligence-pass'

export type IntelligencePassStartResult = BackfillStartResult & {
  error?: string
  upToDate?: boolean
}
export type IntelligencePassStartHandle = Promise<IntelligencePassStartResult> & IntelligencePassStartResult

/**
 * Start one Intelligence pass from an explicit click. Local-first routing is stamped on each
 * queued job. This function is not called from boot, reconcile, consolidation, or a view mount.
 */
export function startIntelligencePass(): IntelligencePassStartHandle {
  const s = getSettings()
  if (pickIntelligencePassCandidates(s).length === 0) {
    const result = { queued: 0, error: intelligenceNoProviderMessage(s, INTELLIGENCE_PASS_NO_PROVIDER) }
    return Object.assign(Promise.resolve(result), result)
  }
  const started: BackfillStartHandle = startBackfill(undefined, { route: 'intelligence-pass', trigger: 'user' })
  const promise = started.then((result): IntelligencePassStartResult => {
    if (result.deferred === 'no-provider') return { queued: 0, error: intelligenceNoProviderMessage(s, INTELLIGENCE_PASS_NO_PROVIDER) }
    auditLog('brain.intelligencePass.start', { queued: result.queued, preparing: result.preparing === true })
    if (result.queued === 0 && !result.preparing) return { ...result, upToDate: true }
    return result
  }) as IntelligencePassStartHandle
  Object.assign(promise, started)
  void promise.then((result) => Object.assign(promise, result), () => {})
  return promise
}
