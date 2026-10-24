import { safeHref } from '@shared/safe-url'

export interface OpenExternalLinkDeps {
  openExternal(url: string): Promise<void>
  /** Tells the user the link did not open. Carries no URL. */
  notifyFailure(): void
}

const OPENABLE = /^(https:|mailto:)/i

/**
 * The one safe path for a model- or user-content link to leave the app (G55): scheme allow-list (https and mailto
 * only; javascript:, file:, data:, custom schemes and plain http never reach the OS), and a failed open is reported to
 * the user instead of being a dropped promise. Resolves true only when the OS accepted the link.
 */
export async function openExternalLink(url: string, deps: OpenExternalLinkDeps): Promise<boolean> {
  const safe = safeHref(url)
  const ok = safe !== null && OPENABLE.test(safe)
  if (ok) {
    try {
      await deps.openExternal(safe)
      return true
    } catch {
      /* falls through to the one visible failure */
    }
  }
  try {
    deps.notifyFailure()
  } catch {
    /* the window may already be gone */
  }
  return false
}
