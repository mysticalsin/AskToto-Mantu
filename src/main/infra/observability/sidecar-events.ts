import { execFileSync } from 'node:child_process'
import type { AuditSink } from '../../logger'
import type { SIDECAR_NAMES } from './projection'

export type SidecarName = (typeof SIDECAR_NAMES)[number]

/** The ChildProcess surface this module reads. */
export interface SidecarProcess {
  readonly pid?: number
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export type ProcessGroupResolver = (pid: number) => number | null

/** Audit a sidecar's spawn and its exit, paired by pid/pgid. Exit can land after `app.shutdown.clean`, or
 *  never land because the process exits first. */
export function observeSidecar(
  name: SidecarName,
  child: SidecarProcess,
  audit: AuditSink,
  clock = (): number => performance.now(),
  resolveProcessGroupId: ProcessGroupResolver = processGroupId
): void {
  const pid = child.pid
  if (pid === undefined) return
  const pgid = resolveProcessGroupId(pid)
  const startedAt = clock()
  audit('sidecar.spawn', { name, pid, pgid })
  child.once('exit', (code, signal) => {
    audit('sidecar.exit', {
      name,
      pid,
      pgid,
      code,
      signal,
      uptimeMs: Math.max(0, clock() - startedAt)
    })
  })
}

function processGroupId(pid: number): number | null {
  if (process.platform === 'win32') return null
  try {
    const output = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    const pgid = Number(output)
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null
  } catch {
    return null
  }
}
