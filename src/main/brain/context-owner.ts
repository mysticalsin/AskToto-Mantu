import { createHash } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { brainDir } from './brain-root'
import type { BrainContextOwner } from './context-envelope'
import { indexUnavailable, readIndex } from './store'

/**
 * The owner a brain-context envelope is bound to: the auth/profile generation, the brain revision and a digest of the
 * partition root in force. The root is the verified tenant and user's partition (G19), so an envelope assembled under
 * one owner can never pass the dispatch-time comparison once another owner's partition is in force.
 */
export function createBrainContextOwner(deps: {
  inputContext(): { authSessionGeneration: number; contextRevision: number }
}): (settings: Settings) => BrainContextOwner {
  return (settings) => {
    const unavailable = indexUnavailable(settings)
    if (unavailable) throw new Error(`Brain context index is unavailable: ${unavailable}`)
    return {
      ...deps.inputContext(),
      brainRevision: readIndex(settings).revision,
      // The partition root is a profile boundary for local brain data. Keep only its digest in the envelope so a
      // raw on-device path can never become prompt or renderer data.
      profileKey: createHash('sha256').update(brainDir(settings)).digest('hex')
    }
  }
}
