import type { AuditSink } from '../../logger'
import type { SIDECAR_NAMES } from './projection'

export type SidecarName = (typeof SIDECAR_NAMES)[number]

/** The ChildProcess surface this module reads. */
export interface SidecarProcess {
  readonly pid?: number
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** Audit a sidecar's spawn and its exit, paired by pid. `pgid` is null: every sidecar today shares the main
 *  process's group (non-detached spawn; Node exposes no getpgid) — M2-0028's supervisor will lead its own.
 *  Exit can land after `app.shutdown.clean`, or never land because the process exits first. */
export function observeSidecar(
  name: SidecarName,
  child: SidecarProcess,
  audit: AuditSink,
  clock = (): number => performance.now()
): void {
  const pid = child.pid
  if (pid === undefined) return
  const startedAt = clock()
  audit('sidecar.spawn', { name, pid, pgid: null })
  child.once('exit', (code, signal) => {
    audit('sidecar.exit', {
      name,
      pid,
      pgid: null,
      code,
      signal,
      uptimeMs: Math.max(0, clock() - startedAt)
    })
  })
}
