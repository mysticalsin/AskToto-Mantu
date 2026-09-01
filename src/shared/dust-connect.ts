/**
 * Dust Connect contract (docs/design/DUST-CONNECT.md).
 *
 * Pure: renderer, main, and tests share one status/copy/privilege model so Settings cannot say
 * Connected while detect still looks at a PATH miss, and so Mac/Windows Quality can count privilege
 * spawns without a GUI box.
 */

export const MANTU_WORKSPACE_NAME = 'Mantu'

/** OS children that can show a password / UAC / Keychain / authorization dialog. */
export type DustPrivilegeKind =
  | 'keychain'
  | 'osascript'
  | 'sudo'
  | 'uac'
  | 'authorization'
  | 'electron-helper'
  | 'npm-global'

export interface DustPrivilegeEvent {
  kind: DustPrivilegeKind
  /** One Connect click = one session. Multiple kinds in the same session still count as one prompt. */
  sessionId: string
}

export type DustConnectStep =
  | { action: 'install' }
  | { action: 'login' }
  | { action: 'import' }
  | { action: 'done' }
  | { action: 'fail'; reason: 'install-failed' | 'missing-binary' | 'no-session' }

export interface DustConnectStatus {
  /** The binary Connect writes (managed userData / ~/.hermes / PATH) is present and runnable. */
  installed: boolean
  /** A Dust session is present (CLI keychain/CredMan or the Métis-persisted token + workspace). */
  live: boolean
  workspaceId?: string
  workspaceName?: string
}

/** Connected is live AND installed. A live session with a missing CLI is not Connected. */
export function isDustCliConnected(s: DustConnectStatus): boolean {
  return s.installed && s.live
}

/**
 * Install → login → import under one consent session.
 * Never recommends a billed probe. Never splits privilege across three spawns.
 */
export function nextDustConnectStep(s: {
  binaryPresent: boolean
  sessionLive: boolean
  installAttempted: boolean
  installOk: boolean | null
  loginAttempted: boolean
}): DustConnectStep {
  if (!s.binaryPresent) {
    if (!s.installAttempted) return { action: 'install' }
    if (s.installOk !== true) return { action: 'fail', reason: 'install-failed' }
    return { action: 'fail', reason: 'missing-binary' }
  }
  if (s.sessionLive) return { action: 'done' }
  if (!s.loginAttempted) return { action: 'login' }
  return { action: 'import' }
}

/**
 * Collapse every privileged child that shares a Connect session to one user consent.
 * Three sequential `security find-generic-password` calls with three session ids = 3 (the Tony bug).
 * Three kinds recorded under one sessionId = 1.
 */
export function countDustPrivilegeSpawns(events: readonly DustPrivilegeEvent[]): number {
  return new Set(events.map((e) => e.sessionId)).size
}

/** Windows Connect must not open UAC + CredMan + npm-global as three elevations. */
export function windowsPrivilegeSpawnKinds(events: readonly DustPrivilegeEvent[]): DustPrivilegeKind[] {
  return events.filter((e) => e.kind === 'uac' || e.kind === 'npm-global' || e.kind === 'electron-helper').map((e) => e.kind)
}

export type DustRowCopy = {
  headline: string
  detail?: string
  tone: 'ok' | 'warn' | 'idle'
}

/**
 * Only row string for Settings → Dust CLI.
 * Invariant: never "Connected" and "not yet installed" in the same state.
 */
export function dustRowCopy(s: DustConnectStatus): DustRowCopy {
  if (s.installed && s.live) {
    const ws = s.workspaceName?.trim() || s.workspaceId?.trim()
    return {
      headline: ws ? `Dust CLI connected · installed · live · ${ws}` : 'Dust CLI connected · installed · live',
      tone: 'ok'
    }
  }
  if (s.live && !s.installed) {
    // Fake Connected is a fail — a persisted key without the Connect binary is not Connected.
    return {
      headline: 'Dust CLI is not yet installed.',
      detail: 'Connect installs the CLI into this app, then signs in. The session alone is not enough.',
      tone: 'warn'
    }
  }
  if (s.installed && !s.live) {
    return {
      headline: 'Dust CLI is installed. Sign in to finish Connect.',
      tone: 'idle'
    }
  }
  return { headline: 'Dust CLI is not yet installed.', tone: 'idle' }
}

/** Structural lock for tests and the Settings contract: Connected copy requires installed. */
export function dustRowCopyIsHonest(s: DustConnectStatus, copy: DustRowCopy = dustRowCopy(s)): boolean {
  const text = `${copy.headline} ${copy.detail ?? ''}`
  const saysConnected = /\bconnected\b/i.test(text)
  const saysMissing = /not yet installed/i.test(text)
  if (saysConnected && saysMissing) return false
  if (saysConnected && !s.installed) return false
  if (saysConnected && !s.live) return false
  return true
}

export interface DustWorkspaceOption {
  sId: string
  name: string
  role?: string
}

/** After login, Mantu wins when it is in the signed-in list. */
export function preferMantuWorkspace(
  workspaces: readonly DustWorkspaceOption[]
): DustWorkspaceOption | null {
  if (workspaces.length === 0) return null
  const exact = workspaces.find((w) => w.name.trim().toLowerCase() === MANTU_WORKSPACE_NAME.toLowerCase())
  if (exact) return exact
  const fuzzy = workspaces.find((w) => new RegExp(`\\b${MANTU_WORKSPACE_NAME}\\b`, 'i').test(w.name))
  return fuzzy ?? workspaces[0] ?? null
}

/**
 * Detect order after Connect: the managed copy Connect wrote, then ~/.hermes, then PATH names.
 * PATH is last so a stale `where dust` miss cannot hide a just-installed managed binary.
 */
export function dustBinCandidates(opts: {
  platform: string
  userData: string
  home: string
  managedEntry?: string | null
}): string[] {
  const win = opts.platform === 'win32'
  const names = win ? ['dust.cmd', 'dust.exe'] : ['dust']
  const out: string[] = []
  if (opts.managedEntry) out.push(opts.managedEntry)
  const managedJs = win
    ? `${opts.userData}\\managed-cli\\dust`
    : `${opts.userData}/managed-cli/dust`
  if (!opts.managedEntry) out.push(managedJs)
  for (const name of names) {
    out.push(win ? `${opts.home}\\.hermes\\bin\\${name}` : `${opts.home}/.hermes/bin/${name}`)
  }
  out.push(...names)
  return out
}
