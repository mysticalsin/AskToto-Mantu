import { isSpeechCapturePurpose } from '@shared/input-session'
import type { InputSessionAuthority } from './input-session-authority'

/**
 * The deadline for a command-mic lease that was admitted but whose capture never started: when it fires and the
 * lease is still the same speech lease (a voice command or, since G22, a dictation), main hard-stops it.
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
        if (lease?.sessionId === sessionId && isSpeechCapturePurpose(lease.purpose)) authority.hardStop('cancelled')
      }, delayMs)
    }
  }
}
