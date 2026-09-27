import type { AuditSink } from '../../logger'
import type { SIDECAR_NAMES } from './projection'

export type SidecarName = (typeof SIDECAR_NAMES)[number]

/** The ChildProcess surface this module reads. */
export interface SidecarProcess {
  readonly pid?: number
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** Audit a sidecar's spawn and its exit, paired by pid; exit can be absent if the app exits first. */
export function observeSidecar(
  _name: SidecarName,
  _child: SidecarProcess,
  _audit: AuditSink,
  _clock = (): number => performance.now()
): void {
  // Scaffolding: the real sidecar lifecycle audit logic lands in the next commit (M2-0215).
  throw new Error('M2-0215: not implemented until the next commit')
}
