import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

// Capture the same host system target used by ST-1; no caller-selected executable is accepted.
export const WIN_TASKKILL = win32.join(
  process.env.SystemRoot || process.env.windir || 'C:\\Windows',
  'System32',
  'taskkill.exe'
)

const REASONS = new Set([
  'invalid-pid',
  'invalid-budget',
  'invalid-receipt',
  'deadline-expired',
  'unsupported-platform',
  'taskkill-failed',
  'taskkill-timeout',
  'root-exit-unobserved',
  'group-still-present',
  'group-probe-permission',
  'group-probe-error'
])
const GROUP_FAILURE_REASONS = new Set(['group-probe-permission', 'group-probe-error'])
const GROUP_FAILURE_PHASES = new Set(['initial-group-probe', 'group-kill', 'post-kill-group-probe'])
const unacknowledged = (reason, diagnostic) =>
  diagnostic ? { state: 'unacknowledged', reason, diagnostic } : { state: 'unacknowledged', reason }
const acknowledged = () => ({ state: 'acknowledged' })

const plainRecord = (value) => {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const hasExactKeys = (keys, expected) => {
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

const hasExactOwnKeys = (value, expected) => hasExactKeys(Reflect.ownKeys(value), expected)

const normalizeGroupDiagnostic = (value) => {
  if (!plainRecord(value) || !hasExactOwnKeys(value, ['phase', 'rootExitObserved', 'groupKillInvoked'])) return null
  const phase = value.phase
  const rootExitObserved = value.rootExitObserved
  const groupKillInvoked = value.groupKillInvoked
  if (
    !GROUP_FAILURE_PHASES.has(phase) ||
    typeof rootExitObserved !== 'boolean' ||
    typeof groupKillInvoked !== 'boolean'
  ) {
    return null
  }
  return {
    phase,
    rootExitObserved,
    groupKillInvoked
  }
}

/** A content-free receipt; never copy OS messages, process paths or arbitrary fields into a report. */
export function normalizeTeardown(value) {
  try {
    if (!plainRecord(value)) return unacknowledged('invalid-receipt')
    const keys = Reflect.ownKeys(value)
    const acknowledgedReceipt = hasExactKeys(keys, ['state'])
    const legacyUnacknowledgedReceipt = hasExactKeys(keys, ['state', 'reason'])
    const groupDiagnosticReceipt = hasExactKeys(keys, ['state', 'reason', 'diagnostic'])
    if (!acknowledgedReceipt && !legacyUnacknowledgedReceipt && !groupDiagnosticReceipt) {
      return unacknowledged('invalid-receipt')
    }
    const state = value.state
    if (acknowledgedReceipt && state === 'acknowledged') return acknowledged()
    if (!legacyUnacknowledgedReceipt && !groupDiagnosticReceipt) return unacknowledged('invalid-receipt')
    const reason = value.reason
    if (legacyUnacknowledgedReceipt && state === 'unacknowledged' && REASONS.has(reason)) {
      return unacknowledged(reason)
    }
    if (groupDiagnosticReceipt && state === 'unacknowledged' && GROUP_FAILURE_REASONS.has(reason)) {
      const diagnosticValue = value.diagnostic
      const diagnostic = normalizeGroupDiagnostic(diagnosticValue)
      if (diagnostic) return unacknowledged(reason, diagnostic)
    }
  } catch {
    // A malformed receipt is not permission to clean up or launch again.
  }
  return unacknowledged('invalid-receipt')
}

const exited = (child) => child.exitCode != null || child.signalCode != null

/** Stop only the child/group spawned by ST-1, then acknowledge termination within one host deadline.
 * Windows proves taskkill /T succeeded and the owned root exited, not independent descendant absence.
 * POSIX additionally requires ESRCH for the owned detached process group.
 * @param {{ pid?: number, exitCode?: number | null, signalCode?: string | null } | null} child
 * @param {{ platform?: string, timeoutMs?: number,
 *   now?: () => number, signal?: (pid: number, kind: string | number) => unknown,
 *   taskkill?: (path: string, args: string[], options: import('node:child_process').ExecFileSyncOptions) => void,
 *   sleep?: (ms: number) => Promise<unknown> }} options */
export async function stopOwnedChild(
  child,
  {
    platform = process.platform,
    timeoutMs = 5_000,
    now = () => performance.now(),
    signal = (pid, kind) => process.kill(pid, kind),
    taskkill = (path, args, options) => {
      execFileSync(path, args, options)
    },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  const pid = child?.pid
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return unacknowledged('invalid-pid')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) return unacknowledged('invalid-budget')
  if (!['darwin', 'linux', 'win32'].includes(platform)) return unacknowledged('unsupported-platform')
  const deadline = now() + timeoutMs
  const remaining = () => Math.max(0, deadline - now())
  const pause = () => sleep(Math.min(25, remaining()))

  if (platform === 'win32') {
    if (exited(child)) return unacknowledged('root-exit-unobserved')
    if (!win32.isAbsolute(WIN_TASKKILL)) return unacknowledged('taskkill-failed')
    const budget = Math.floor(remaining())
    if (budget <= 0) return unacknowledged('taskkill-timeout')
    try {
      taskkill(WIN_TASKKILL, ['/pid', String(pid), '/T', '/F'], {
        timeout: budget,
        killSignal: 'SIGKILL',
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (error) {
      return unacknowledged(error?.code === 'ETIMEDOUT' ? 'taskkill-timeout' : 'taskkill-failed')
    }
    while (remaining() > 0) {
      if (exited(child)) return acknowledged()
      await pause()
    }
    return unacknowledged('root-exit-unobserved')
  }

  const probe = () => {
    try {
      signal(-pid, 0)
      return 'present'
    } catch (error) {
      if (error?.code === 'ESRCH') return 'absent'
      return error?.code === 'EPERM' ? 'group-probe-permission' : 'group-probe-error'
    }
  }
  const groupFailure = (reason, phase, groupKillInvoked) =>
    unacknowledged(reason, {
      phase,
      rootExitObserved: exited(child),
      groupKillInvoked
    })
  let groupKillInvoked = false
  let group = probe()
  if (remaining() <= 0) return unacknowledged('deadline-expired')
  if (group !== 'present' && group !== 'absent') return groupFailure(group, 'initial-group-probe', groupKillInvoked)
  // Never kill a possibly reused PGID after the owned root has already exited.
  if (exited(child)) return group === 'absent' ? acknowledged() : unacknowledged('group-still-present')
  if (group === 'present') {
    if (remaining() <= 0) return unacknowledged('group-still-present')
    try {
      groupKillInvoked = true
      signal(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        return groupFailure(
          error?.code === 'EPERM' ? 'group-probe-permission' : 'group-probe-error',
          'group-kill',
          groupKillInvoked
        )
      }
    }
  }
  while (remaining() > 0) {
    group = probe()
    if (remaining() <= 0) return unacknowledged('deadline-expired')
    if (group === 'group-probe-permission' && platform === 'darwin' && groupKillInvoked) {
      await pause()
      continue
    }
    if (group !== 'present' && group !== 'absent') {
      return groupFailure(group, 'post-kill-group-probe', groupKillInvoked)
    }
    if (group === 'absent' && exited(child)) return acknowledged()
    await pause()
  }
  if (group === 'group-probe-permission' && platform === 'darwin' && groupKillInvoked) {
    return groupFailure(group, 'post-kill-group-probe', groupKillInvoked)
  }
  return unacknowledged(group === 'present' ? 'group-still-present' : 'root-exit-unobserved')
}
