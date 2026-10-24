export type GraphTokenOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: 'not_configured' | 'no_account' | 'interaction_required' | 'transient' }

const INTERACTION_REQUIRED_GRAPH_ERROR_CODES = new Set([
  'invalid_grant',
  'no_tokens_found',
  'refresh_token_expired',
  'ui_not_allowed',
  'consent_required',
  'interaction_required',
  'login_required',
  'bad_token',
  'interrupted_user'
])

/**
 * Classify a silent-token failure: true when only an interactive sign-in can recover it, false for transient
 * failures. `loadInteractionError` is the lazy MSAL accessor, so this module never pulls msal onto the boot path.
 */
function graphTokenNeedsInteraction(
  error: unknown,
  loadInteractionError: () => (new (...args: never[]) => Error) | undefined
): boolean {
  try {
    const InteractionRequiredAuthError = loadInteractionError()
    if (InteractionRequiredAuthError && error instanceof InteractionRequiredAuthError) return true
  } catch {
    // A failed lazy MSAL load is not a reason to hide the original transient failure.
  }
  if (!error || typeof error !== 'object') return false
  try {
    const errorCode = (error as { errorCode?: unknown }).errorCode
    return typeof errorCode === 'string' && INTERACTION_REQUIRED_GRAPH_ERROR_CODES.has(errorCode.trim().toLowerCase())
  } catch {
    return false
  }
}

export function graphTokenFailure(
  error: unknown,
  loadInteractionError: () => (new (...args: never[]) => Error) | undefined
): GraphTokenOutcome {
  return {
    ok: false,
    reason: graphTokenNeedsInteraction(error, loadInteractionError) ? 'interaction_required' : 'transient'
  }
}
