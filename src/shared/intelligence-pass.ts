/**
 * Mantu Intelligence Update — copy and the button-only contract.
 * See docs/design/INTELLIGENCE-UPDATE.md. This pass never auto-starts and never auto-sends.
 */

export const INTELLIGENCE_UPDATE_LABEL = 'Update Intelligence'
export const INTELLIGENCE_UPDATING_LABEL = 'Updating'

export const INTELLIGENCE_PASS_NO_PROVIDER =
  'Turn on Local AI in Settings, or connect an API provider, to update Intelligence.'

export const INTELLIGENCE_PASS_BOTH_FAILED =
  'Local AI and the API could not update Intelligence. Check Settings → Local AI, then your API provider.'

export const INTELLIGENCE_PASS_EMPTY =
  'Save a meeting, then use Update Intelligence to build your knowledge from the transcript.'

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
  refresh: () => Promise<void>
  setError: (message: string | null) => void
}): Promise<IntelligencePassResult> {
  host.setError(null)
  const result = await host.runPass()
  if (result.error) {
    host.setError(result.error)
    return result
  }
  if (result.deferred === 'no-provider') {
    host.setError(INTELLIGENCE_PASS_NO_PROVIDER)
    return result
  }
  await host.refresh()
  return result
}
