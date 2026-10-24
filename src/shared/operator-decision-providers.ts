/**
 * Operator heartbeat `decisionProviders` (command JEV, Cap 1). Pure and fail-closed: only the literal boolean
 * `true` turns a provider on, so a missing field, a string or a number never enables a remote decision call.
 */
export interface HeartbeatDecisionProviders {
  jev: boolean
}

/** A heartbeat arrives every minute; JEV reads OFF when the last answer is older than this. */
export const COMMAND_JEV_TTL_MS = 5 * 60_000

export function parseHeartbeatDecisionProviders(json: unknown): HeartbeatDecisionProviders {
  if (!json || typeof json !== 'object') return { jev: false }
  const providers = (json as { decisionProviders?: unknown }).decisionProviders
  if (!providers || typeof providers !== 'object') return { jev: false }
  return { jev: (providers as { jev?: unknown }).jev === true }
}
