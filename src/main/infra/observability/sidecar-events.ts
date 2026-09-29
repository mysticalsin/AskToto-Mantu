import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AuditSink } from '../../logger'
import type { SIDECAR_NAMES } from './projection'

export type SidecarName = (typeof SIDECAR_NAMES)[number]

/** The ChildProcess surface this module reads. */
export interface SidecarProcess {
  readonly pid?: number
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

type PgidResult = number | null

/** Resolves a pid's process group. May be asynchronous: the production resolver runs `ps`, which must never
 *  block the main thread at boot. */
export type ProcessGroupResolver = (pid: number) => PgidResult | Promise<PgidResult>

/** Audit a sidecar's spawn and its exit, paired by pid/pgid. Exit can land after `app.shutdown.clean`, or
 *  never land because the process exits first. A resolver that returns a promise defers the spawn audit until
 *  the pgid is known; an exit that lands first is audited after it, so spawn always precedes exit. */
export function observeSidecar(
  name: SidecarName,
  child: SidecarProcess,
  audit: AuditSink,
  clock = (): number => performance.now(),
  resolveProcessGroupId: ProcessGroupResolver = processGroupId
): void {
  const pid = child.pid
  if (pid === undefined) return
  const startedAt = clock()
  const resolved = resolveProcessGroupId(pid)
  const whenPgid = (fn: (pgid: PgidResult) => void): void => {
    if (resolved instanceof Promise) void resolved.then(fn, () => fn(null))
    else fn(resolved)
  }
  whenPgid((pgid) => audit('sidecar.spawn', { name, pid, pgid }))
  child.once('exit', (code, signal) => {
    const uptimeMs = Math.max(0, clock() - startedAt)
    whenPgid((pgid) => audit('sidecar.exit', { name, pid, pgid, code, signal, uptimeMs }))
  })
}

function processGroupId(pid: number): PgidResult | Promise<PgidResult> {
  if (process.platform === 'win32') return null
  return posixProcessGroupId(pid)
}

async function posixProcessGroupId(pid: number): Promise<PgidResult> {
  try {
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000
    })
    const pgid = Number(stdout.trim())
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null
  } catch {
    return null
  }
}
