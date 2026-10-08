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
const unacknowledged = (reason) => ({ state: 'unacknowledged', reason })
const acknowledged = () => ({ state: 'acknowledged' })

/** A content-free receipt; never copy OS messages, process paths or arbitrary fields into a report. */
export function normalizeTeardown(value) {
  try {
    if (!value || typeof value !== 'object') return unacknowledged('invalid-receipt')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return unacknowledged('invalid-receipt')
    const keys = Reflect.ownKeys(value)
    if (!keys.includes('state')) return unacknowledged('invalid-receipt')
    if (value.state === 'acknowledged' && keys.length === 1) return acknowledged()
    if (value.state === 'unacknowledged' && REASONS.has(value.reason) && keys.length === 2 && keys.includes('reason')) {
      return unacknowledged(value.reason)
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
  let group = probe()
  if (remaining() <= 0) return unacknowledged('deadline-expired')
  if (group !== 'present' && group !== 'absent') return unacknowledged(group)
  // Never kill a possibly reused PGID after the owned root has already exited.
  if (exited(child)) return group === 'absent' ? acknowledged() : unacknowledged('group-still-present')
  if (group === 'present') {
    if (remaining() <= 0) return unacknowledged('group-still-present')
    try {
      signal(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        return unacknowledged(error?.code === 'EPERM' ? 'group-probe-permission' : 'group-probe-error')
      }
    }
  }
  while (remaining() > 0) {
    group = probe()
    if (remaining() <= 0) return unacknowledged('deadline-expired')
    if (group !== 'present' && group !== 'absent') return unacknowledged(group)
    if (group === 'absent' && exited(child)) return acknowledged()
    await pause()
  }
  return unacknowledged(group === 'present' ? 'group-still-present' : 'root-exit-unobserved')
}
