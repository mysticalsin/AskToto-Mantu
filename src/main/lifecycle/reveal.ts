import type { OverlayLayout } from '@shared/overlay-chrome'

export type RevealReason =
  | 'activate'
  | 'second-instance'
  | 'tray'
  | 'hotkey'
  | 'notification-click'

export type PresenterState =
  | { kind: 'PARKED'; layout: OverlayLayout }
  | { kind: 'REVEALED' }
  | { kind: 'HIDDEN' }

export interface RevealOptions {
  focus?: boolean
}

export interface RevealWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  showInactive(): void
  focus(): void
}

export interface RevealControllerDeps {
  ensureWindow(): RevealWindow | null
  legacyRevealEnabled(): boolean
  legacyReveal(reason: RevealReason, options: Required<RevealOptions>): void
  presenterState(): PresenterState
  cancelPendingRepark(): void
  restoreInteractiveLayout(): void
  repairOffscreenBounds(): void
  disableClickThrough(): void
}

export interface RevealResult {
  state: PresenterState
  action: 'revealed' | 'pending' | 'ignored-boot' | 'missing-window' | 'legacy'
}

export interface RevealController {
  reveal(reason: RevealReason, options?: RevealOptions): RevealResult
  markBootComplete(): RevealResult | null
  hasPendingReveal(): boolean
}

export function revealLegacyEnabled(
  env: { METIS_REVEAL?: string },
  argv: readonly string[]
): boolean {
  return (
    env.METIS_REVEAL === 'legacy' ||
    argv.includes('--reveal.legacy') ||
    argv.includes('reveal.legacy') ||
    argv.includes('--reveal=legacy') ||
    argv.includes('reveal=legacy')
  )
}

export function legacyRevealWindow(
  reason: RevealReason,
  options: Required<RevealOptions>,
  w: RevealWindow,
  showForAsk: (w: RevealWindow) => void
): void {
  if (reason === 'activate' || reason === 'second-instance') {
    w.showInactive()
    return
  }
  if (options.focus) {
    showForAsk(w)
    return
  }
  if (!w.isVisible()) w.showInactive()
}

export function createRevealController(deps: RevealControllerDeps): RevealController {
  let bootComplete = false
  let pendingReveal: { reason: RevealReason; options: Required<RevealOptions> } | null = null

  const normalize = (options: RevealOptions | undefined): Required<RevealOptions> => ({
    focus: options?.focus === true
  })

  const revealNow = (reason: RevealReason, options: Required<RevealOptions>): RevealResult => {
    if (deps.legacyRevealEnabled()) {
      deps.legacyReveal(reason, options)
      return { state: deps.presenterState(), action: 'legacy' }
    }

    const w = deps.ensureWindow()
    if (!w || w.isDestroyed()) return { state: { kind: 'HIDDEN' }, action: 'missing-window' }

    deps.cancelPendingRepark()
    deps.restoreInteractiveLayout()
    deps.repairOffscreenBounds()
    deps.disableClickThrough()

    if (options.focus) {
      w.show()
      w.focus()
    } else if (!w.isVisible()) {
      w.showInactive()
    }

    return { state: deps.presenterState(), action: 'revealed' }
  }

  return {
    reveal(reason, options) {
      const normalized = normalize(options)
      if (!bootComplete) {
        if (reason === 'second-instance') {
          pendingReveal = { reason, options: normalized }
          return { state: deps.presenterState(), action: 'pending' }
        }
        return { state: deps.presenterState(), action: 'ignored-boot' }
      }
      return revealNow(reason, normalized)
    },

    markBootComplete() {
      bootComplete = true
      if (!pendingReveal) return null
      const pending = pendingReveal
      pendingReveal = null
      return revealNow(pending.reason, pending.options)
    },

    hasPendingReveal() {
      return pendingReveal !== null
    }
  }
}
