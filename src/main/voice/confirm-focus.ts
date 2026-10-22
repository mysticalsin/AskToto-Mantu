/**
 * Focus for the confirmation card (owner decision D-10: the card is the third exception to no-focus-steal).
 *
 * The card is the one decision moment of a voice action, so it takes focus. This controller owns only the policy
 * around that: remember which app was in front, ask for the card's window to be shown and focused (an injected
 * function that lives beside the other two exceptions in index.ts), and give focus back when the card is
 * resolved. It never touches a window itself.
 *
 * Focus is not restored when the person has already moved on (clicked away, locked the Mac, a meeting stopped
 * things) or when another card replaces this one. It is restored once per card, bounded so a hung helper can never
 * hold up a confirmed action.
 */

export interface PreviousApp {
  pid: number
  /** macOS bundle id, or the Windows window handle. Informational: the pid is what is activated. */
  windowId: string
}

export interface ConfirmFocusDeps {
  platform: NodeJS.Platform
  ownPid: number
  /** The app that is in front now (the foreground watcher's last observation), or null when unknown. */
  frontmost(): PreviousApp | null
  /** Un-park the overlay if needed, then show and focus it: the third exception in index.ts. */
  showForConfirm(): void
  /** macOS: bring that application back (helper `activate-pid`). */
  activatePid(pid: number): Promise<boolean>
  /** Windows: blur the overlay so the system returns to the previous window. Measured by the V04 spike (ASSUMED). */
  blurWindow(): void
}

export interface ConfirmFocus {
  /** A proposed card appeared: remember the previous app and take focus. */
  presented(): void
  /** The card ended. Restores focus for the reasons where the person is still looking at the card. */
  release(reason: string): Promise<void>
  previous(): PreviousApp | null
}

/** Reasons after which the person was still on the card, so focus goes back to where they were. */
const RESTORE_REASONS: ReadonlySet<string> = new Set([
  'cancelled',
  'expired',
  'confirmed',
  'policy_denied',
  'preflight_failed',
  'runtime_proposal_cleared'
])

const RESTORE_TIMEOUT_MS = 1_500

export function createConfirmFocus(deps: ConfirmFocusDeps): ConfirmFocus {
  let active = false
  let previous: PreviousApp | null = null

  return {
    presented() {
      // A replacement card keeps the original previous app: by now the overlay itself is in front.
      if (!active) {
        const front = deps.frontmost()
        previous = front && front.pid !== deps.ownPid ? front : null
        active = true
      }
      deps.showForConfirm()
    },
    async release(reason) {
      if (!active) return
      active = false
      const target = previous
      previous = null
      if (!RESTORE_REASONS.has(reason)) return
      try {
        if (deps.platform === 'darwin') {
          if (!target) return
          await Promise.race([
            deps.activatePid(target.pid),
            new Promise<void>((resolve) => {
              setTimeout(resolve, RESTORE_TIMEOUT_MS).unref?.()
            })
          ])
        } else if (deps.platform === 'win32') {
          deps.blurWindow()
        }
      } catch {
        // Restoring focus is best effort; the decision it follows is already made.
      }
    },
    previous: () => previous
  }
}
