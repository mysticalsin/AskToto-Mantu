import { INTELLIGENCE_STATUS_UNAVAILABLE } from '@shared/intelligence-pass'

/** A contained refresh still returns its outcome to an explicit click; coalesced callers await it. */
export function createBrainRefresh<T>(
  read: () => Promise<T>,
  apply: (snapshot: T) => void,
  onFailure: (message: string) => void,
  onSettled: () => void
): () => Promise<{ ok: boolean }> {
  let pending: Promise<{ ok: boolean }> | null = null
  return () => {
    if (pending) return pending
    pending = Promise.resolve()
      .then(read)
      .then((snapshot) => {
        apply(snapshot)
        return { ok: true }
      })
      .catch(() => {
        onFailure(INTELLIGENCE_STATUS_UNAVAILABLE)
        return { ok: false }
      })
      .finally(() => {
        pending = null
        onSettled()
      })
    return pending
  }
}
