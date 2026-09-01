import { connectCliSession, type CliSessionProvider } from './providers'

export type CliSessionVerdict = 'live' | 'signed-out' | 'unknown'

export type CliConnectDecision =
  | { action: 'install' }
  | { action: 'login' }
  | { action: 'wait-login' }
  | { action: 'connect' }
  | { action: 'fail'; reason: 'install-failed' | 'missing-binary' | 'no-session' }

/**
 * One-click Settings Connect walk (DESIGN.md Cloud CLI + Codex CLI one-click).
 * Pure: the renderer/main apply the action. Never recommends a billed one-turn probe.
 */
export function nextCliConnectStep(s: {
  binaryPresent: boolean
  session: CliSessionVerdict | null
  installAttempted: boolean
  installOk: boolean | null
  loginAttempted: boolean
}): CliConnectDecision {
  if (!s.binaryPresent) {
    if (!s.installAttempted) return { action: 'install' }
    if (s.installOk !== true) return { action: 'fail', reason: 'install-failed' }
    return { action: 'fail', reason: 'missing-binary' }
  }
  if (s.session === 'live') return { action: 'connect' }
  if (!s.loginAttempted) return { action: 'login' }
  if (s.session === 'signed-out' || s.session === 'unknown' || s.session === null) {
    return { action: 'wait-login' }
  }
  return { action: 'wait-login' }
}

/** Connected badge is only legal after a live zero-token session probe. */
export function cliConnectPatchIfLive(
  provider: CliSessionProvider,
  cliConnected: Record<string, boolean>,
  session: CliSessionVerdict
): { cliConnected: Record<string, boolean>; provider: CliSessionProvider } | null {
  if (session !== 'live') return null
  return connectCliSession(provider, cliConnected)
}
