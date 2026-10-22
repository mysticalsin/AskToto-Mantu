/** Abort handle of one in-flight ask, keyed by the renderer's ask id. */
export type AskStreamRegistry = Map<string, { abort: () => void }>

/**
 * Abort every in-flight ask and empty the registry. Used wherever the owner of those answers goes away:
 * the window is replaced, the app shuts down, or the session is cleared. At a session boundary this is the
 * only way a running answer stops, because askCancel is itself auth-gated (AUDIT-10): without it a provider
 * request keeps streaming, and billing, after sign-out. One handle that throws must not keep the rest alive.
 */
export function abortAllAskStreams(streams: AskStreamRegistry): void {
  for (const stream of streams.values()) {
    try {
      stream.abort()
    } catch {
      /* best-effort: keep tearing the others down */
    }
  }
  streams.clear()
}

/** The renderer's answer id for a feedback rating: a non-blank string of at most 128 characters, else
 *  undefined so the rating falls back to the last ask instead of recording junk. */
export function boundedAnswerAskId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= 128 ? raw : undefined
}
