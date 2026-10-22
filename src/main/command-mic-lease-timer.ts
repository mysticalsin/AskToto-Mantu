import type { InputSessionAuthority } from './input-session-authority'

/**
 * The deadline for a command-mic lease that was admitted but whose capture never started: when it fires and the
 * lease is still the same command lease, main hard-stops it. Moved out of index.ts unchanged.
 */
export function createCommandMicLeaseTimer(deps: {
  /** The command lease id main currently tracks. */
  leaseId(): string | null
  authority(): Pick<InputSessionAuthority, 'activeLease' | 'hardStop'>
}): { clear(sessionId?: string): void; arm(sessionId: string, delayMs: number): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (sessionId?: string): void => {
    if (sessionId && deps.leaseId() !== sessionId) return
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    clear,
    arm(sessionId, delayMs) {
      clear()
      timer = setTimeout(() => {
        timer = null
        const authority = deps.authority()
        const lease = authority.activeLease
        if (lease?.sessionId === sessionId && lease.purpose === 'command') authority.hardStop('cancelled')
      }, delayMs)
    }
  }
}
