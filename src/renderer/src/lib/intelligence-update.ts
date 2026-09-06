/** Shared Update Intelligence click contract. Surfaces a real error; never a silent no-op. */

export const NO_PROVIDER_INDEX_COPY =
  'Connect an AI provider in Settings → AI, or enable Métis Local there to index meetings on this device.'

export const SIGN_IN_INDEX_COPY = 'Sign in with your Mantu account first.'

export interface IntelligenceUpdateResult {
  queued?: number
  deferred?: 'no-provider' | string
  preparing?: boolean
  error?: string
  recapped?: number
  upToDate?: boolean
}

export function intelligenceUpdateError(result: IntelligenceUpdateResult): string | null {
  if (result.error?.trim()) return result.error.trim()
  if (result.deferred === 'no-provider') return NO_PROVIDER_INDEX_COPY
  return null
}

export function ipcFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return SIGN_IN_INDEX_COPY
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
