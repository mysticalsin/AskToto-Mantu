/** Same click contract as the overlay Update Intelligence button. */

export const NO_PROVIDER_INDEX_COPY =
  'Connect an AI provider in Settings → AI, or enable Métis Local there to index meetings on this device.'

export const SIGN_IN_INDEX_COPY = 'Sign in with your Mantu account first.'

export const INTELLIGENCE_UPDATE_TRANSPORT_COPY =
  'The update status could not be confirmed. It may still be running. Wait for status to recover before trying again.'

export const INTELLIGENCE_STATUS_UNAVAILABLE_COPY =
  'The update may still be running, but its status is unavailable. Wait for status to recover before trying again.'

export interface IntelligenceUpdateResult {
  queued?: number
  deferred?: string
  preparing?: boolean
  error?: string
}

export function intelligenceUpdateError(result: IntelligenceUpdateResult): string | null {
  const error = result.error?.trim()
  if (error === SIGN_IN_INDEX_COPY || error === NO_PROVIDER_INDEX_COPY) return error
  if (error) return INTELLIGENCE_UPDATE_TRANSPORT_COPY
  if (result.deferred === 'no-provider') return NO_PROVIDER_INDEX_COPY
  return null
}

export function ipcFailureMessage(_error: unknown): string {
  return INTELLIGENCE_UPDATE_TRANSPORT_COPY
}

export async function runIntelligenceUpdateClick(
  invoke: () => Promise<IntelligenceUpdateResult>
): Promise<{ error: string | null }> {
  try {
    return { error: intelligenceUpdateError(await invoke()) }
  } catch (error) {
    return { error: ipcFailureMessage(error) }
  }
}

export interface IntelligenceIndexStatus {
  running?: boolean
  lastError?: string | null
}

export interface IntelligenceUpdateViewState {
  busy: boolean
  error: string | null
  errorKind: 'action' | 'transport' | null
}

export function intelligenceUpdateViewState(
  local: IntelligenceUpdateViewState,
  status: IntelligenceIndexStatus | null | undefined
): IntelligenceUpdateViewState {
  const busy = local.busy || status?.running === true
  const statusError = status?.lastError?.trim() || null
  return {
    busy,
    error: busy ? null : statusError || local.error,
    errorKind: busy || statusError ? null : local.errorKind
  }
}

/** A later valid status proves the bridge recovered; only actionable provider guidance persists. */
export function clearRecoveredIntelligenceUpdateError(
  local: IntelligenceUpdateViewState
): IntelligenceUpdateViewState {
  return local.errorKind === 'transport'
    ? { busy: local.busy, error: null, errorKind: null }
    : local
}

export type IntelligenceUpdateAttemptResult = 'ignored' | 'running' | 'complete' | 'failed'

/** One button attempt. The latch closes before React can render, so rapid clicks cannot re-enter. */
export function createIntelligenceUpdateAttempt(
  onState: (state: IntelligenceUpdateViewState) => void
): {
  run: (
    invoke: () => Promise<IntelligenceUpdateResult>,
    refreshStatus: () => Promise<IntelligenceIndexStatus | null>
  ) => Promise<IntelligenceUpdateAttemptResult>
} {
  let busy = false

  const publish = (state: IntelligenceUpdateViewState): void => onState(state)

  const run = async (
    invoke: () => Promise<IntelligenceUpdateResult>,
    refreshStatus: () => Promise<IntelligenceIndexStatus | null>
  ): Promise<IntelligenceUpdateAttemptResult> => {
    if (busy) return 'ignored'
    busy = true
    publish({ busy: true, error: null, errorKind: null })

    const dispatched = await runIntelligenceUpdateClick(invoke)
    if (dispatched.error) {
      busy = false
      const actionError =
        dispatched.error === SIGN_IN_INDEX_COPY || dispatched.error === NO_PROVIDER_INDEX_COPY
      publish({
        busy: false,
        error: dispatched.error,
        errorKind: actionError ? 'action' : 'transport'
      })
      return 'failed'
    }

    let status: IntelligenceIndexStatus | null
    try {
      status = await refreshStatus()
    } catch {
      busy = false
      publish({
        busy: false,
        error: INTELLIGENCE_UPDATE_TRANSPORT_COPY,
        errorKind: 'transport'
      })
      return 'failed'
    }

    if (!status) {
      busy = false
      publish({
        busy: false,
        error: INTELLIGENCE_STATUS_UNAVAILABLE_COPY,
        errorKind: 'transport'
      })
      return 'failed'
    }

    busy = false
    const terminalError = !status.running && status.lastError?.trim()
      ? status.lastError.trim()
      : null
    // The hook already published this authoritative status. Keep terminal errors in that shared
    // source so a later successful status cannot resurrect an obsolete local copy.
    publish({ busy: false, error: null, errorKind: null })
    if (terminalError) return 'failed'
    return status.running ? 'running' : 'complete'
  }

  return { run }
}
