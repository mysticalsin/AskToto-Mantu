/**
 * Mantu Intelligence Update — copy and the button-only contract.
 * See docs/design/INTELLIGENCE-UPDATE.md. This pass never auto-starts and never auto-sends.
 */
import type { Settings } from './ipc'

export const INTELLIGENCE_UPDATE_LABEL = 'Update Intelligence'
export const INTELLIGENCE_UPDATING_LABEL = 'Updating'

export const INTELLIGENCE_PASS_NO_PROVIDER =
  'Turn on Local AI in Settings, or connect an API provider, to update Intelligence.'

export const LOCAL_ONLY_INTELLIGENCE_UNAVAILABLE =
  'Local-only meeting processing is enabled, but Métis Local is not ready. Open Settings → AI → Local AI. Nothing was sent to the cloud.'

export function intelligenceRequiresLocal(s: Pick<Settings, 'localLlm' | 'routingMode' | 'brainConsolidation'>): boolean {
  return s.localLlm.useFor.summary || s.routingMode === 'local' || s.brainConsolidation.preferLocal
}

export function intelligenceNoProviderMessage(
  s: Pick<Settings, 'localLlm' | 'routingMode' | 'brainConsolidation'>,
  fallback = INTELLIGENCE_PASS_NO_PROVIDER
): string {
  return intelligenceRequiresLocal(s) ? LOCAL_ONLY_INTELLIGENCE_UNAVAILABLE : fallback
}

export const INTELLIGENCE_PASS_BOTH_FAILED =
  'Local AI and the API could not update Intelligence. Check Settings → Local AI, then your API provider.'

export const INTELLIGENCE_PASS_EMPTY =
  'Save a meeting, then use Update Intelligence to build your knowledge from the transcript.'

export const INTELLIGENCE_UPDATE_UNCONFIRMED =
  'Could not confirm the Intelligence update. Check its status before trying again.'

export const INTELLIGENCE_STATUS_UNAVAILABLE =
  'The Intelligence update may still be running. Could not refresh its status; reopen Intelligence to check.'

/** This pass starts only from the Update Intelligence click. Never from mount, poll, or a timer. */
export const INTELLIGENCE_PASS_AUTO_START = false

export interface IntelligencePassResult {
  queued: number
  deferred?: 'no-provider'
  preparing?: boolean
  error?: string
  upToDate?: boolean
}

export async function startIntelligenceUpdateFromClick(host: {
  runPass: () => Promise<IntelligencePassResult>
  refresh: () => Promise<void | { ok: boolean }>
  setError: (message: string | null) => void
}): Promise<IntelligencePassResult> {
  host.setError(null)
  let result: IntelligencePassResult
  try {
    result = await host.runPass()
  } catch {
    host.setError(INTELLIGENCE_UPDATE_UNCONFIRMED)
    return { queued: 0, error: INTELLIGENCE_UPDATE_UNCONFIRMED }
  }
  if (result.error) {
    host.setError(result.error)
    return result
  }
  if (result.deferred === 'no-provider') {
    host.setError(INTELLIGENCE_PASS_NO_PROVIDER)
    return result
  }
  try {
    const refreshed = await host.refresh()
    if (refreshed && !refreshed.ok) {
      host.setError(INTELLIGENCE_STATUS_UNAVAILABLE)
      return { ...result, error: INTELLIGENCE_STATUS_UNAVAILABLE }
    }
  } catch {
    host.setError(INTELLIGENCE_STATUS_UNAVAILABLE)
    return { ...result, error: INTELLIGENCE_STATUS_UNAVAILABLE }
  }
  return result
}
