export type AskStreamHandle = { abort: () => void }

export interface PendingAskCancellation {
  releaseIfPending(): void
  stillPending(): boolean
}

export function registerPendingAskCancellation(
  streams: Map<string, AskStreamHandle>,
  id: string
): PendingAskCancellation {
  let cancelled = false
  const placeholder: AskStreamHandle = {
    abort: () => {
      cancelled = true
    }
  }
  streams.set(id, placeholder)
  return {
    releaseIfPending() {
      if (streams.get(id) === placeholder) streams.delete(id)
    },
    stillPending() {
      return !cancelled && streams.get(id) === placeholder
    }
  }
}
