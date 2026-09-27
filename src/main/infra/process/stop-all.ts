/**
 * The one teardown of the child processes this app owns. Every exit path runs it (lifecycle/exit-paths.ts):
 * will-quit, the emergency hard exit and the relaunch after a fatal error. It only sends signals and never
 * waits, so it finishes in bounded time even when a renderer or a child is hung, and running it again is
 * harmless.
 */

/** A family of child processes the OS does not end together with this app. */
export interface OwnedChildren {
  /** Stable name for the failure log. */
  readonly name: string
  /** Signal every live child of the family to terminate. Synchronous and idempotent; never starts one. */
  readonly stop: () => void
}

/**
 * Build stopAll(): stop each family in list order. A family whose stop() throws is reported through onError
 * and never keeps a later family running.
 */
export function createStopAll(
  families: readonly OwnedChildren[],
  onError: (name: string, error: unknown) => void
): () => void {
  return () => {
    for (const { name, stop } of families) {
      try {
        stop()
      } catch (error) {
        onError(name, error)
      }
    }
  }
}
