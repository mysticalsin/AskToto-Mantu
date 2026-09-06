/**
 * Cloud Code (claude-cli) + Codex (codex-cli) "Set up automatically" walk.
 * Honest chip: Installing → Waiting for login → Connected.
 * Connected requires a working binary AND a successful testCli / cliConnected — never the button returning.
 * Never stores CLI tokens. Dust stays retrieval-only.
 */

export type CliSetupChipKind = 'idle' | 'installing' | 'waiting-for-login' | 'connected' | 'failed'

export type CliSetupDecision =
  | { action: 'install' }
  | { action: 'login' }
  | { action: 'wait-login' }
  | { action: 'connect' }
  | { action: 'fail'; reason: 'install-failed' | 'missing-binary' | 'no-session' }

export function canShowConnected(s: { binaryPresent: boolean; testOk: boolean }): boolean {
  return s.binaryPresent === true && s.testOk === true
}

export function nextCliSetupStep(s: {
  binaryPresent: boolean
  testOk: boolean
  installAttempted: boolean
  installOk: boolean | null
  loginAttempted: boolean
}): CliSetupDecision {
  if (canShowConnected(s)) return { action: 'connect' }
  if (!s.binaryPresent) {
    if (!s.installAttempted) return { action: 'install' }
    if (s.installOk !== true) return { action: 'fail', reason: 'install-failed' }
    return { action: 'fail', reason: 'missing-binary' }
  }
  if (!s.loginAttempted) return { action: 'login' }
  if (!s.testOk) return { action: 'wait-login' }
  return { action: 'fail', reason: 'no-session' }
}

export function cliSetupChip(s: {
  binaryPresent: boolean
  testOk: boolean
  installing: boolean
  loginOpened: boolean
  error: string | null
}): { kind: CliSetupChipKind; label: string } {
  if (s.error) return { kind: 'failed', label: s.error }
  if (canShowConnected(s)) return { kind: 'connected', label: 'Connected' }
  if (s.installing) return { kind: 'installing', label: 'Installing' }
  if (s.loginOpened) return { kind: 'waiting-for-login', label: 'Waiting for login' }
  return { kind: 'idle', label: '' }
}
