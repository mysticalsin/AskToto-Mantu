/**
 * desktop-frontmost-verifier.ts: proof that an app came to the front (V03).
 *
 * `open -b <bundle id>` only proves the request was handed to the operating system. The helper's frontmost
 * stream (the same producer the foreground watcher uses) prints the current app when it starts and then one line
 * per activation, with the bundle id as the window id. An observation starts that stream BEFORE the launch, takes
 * the first line as the baseline, and counts only a LATER line naming the expected bundle id, within the window.
 * If the app was already frontmost, or the stream cannot be read, nothing is proven and the outcome stays
 * unverified: never verified without evidence.
 */
import type { ForegroundInfo, ForegroundWatcher } from './foreground-watcher'

export interface FrontmostObservation {
  /** True once the stream reported its baseline. Launch only after this, or the activation can be missed. */
  ready(): Promise<boolean>
  /** True when the expected bundle id was seen activating within the window after this call. */
  matched(): Promise<boolean>
  /** Stop the stream. Idempotent. */
  cancel(): void
}

export interface FrontmostVerifier {
  observe(bundleId: string, windowMs: number): FrontmostObservation
}

export interface FrontmostVerifierDeps {
  start(onChange: (info: ForegroundInfo) => void): ForegroundWatcher
  /** How long the stream may take to report its baseline. */
  readyTimeoutMs?: number
}

const READY_TIMEOUT_MS = 1_500

export function createFrontmostVerifier(deps: FrontmostVerifierDeps): FrontmostVerifier {
  return {
    observe(bundleId, windowMs) {
      let baselineSeen = false
      let matchedAt = false
      let cancelled = false
      let readyResolve: (value: boolean) => void = () => undefined
      let matchResolve: ((value: boolean) => void) | null = null
      const readyPromise = new Promise<boolean>((resolve) => {
        readyResolve = resolve
      })
      let watcher: ForegroundWatcher | null = null
      const timers: ReturnType<typeof setTimeout>[] = []

      const stop = (): void => {
        cancelled = true
        for (const timer of timers) clearTimeout(timer)
        timers.length = 0
        try {
          watcher?.stop()
        } catch {
          /* already gone */
        }
        readyResolve(baselineSeen)
        matchResolve?.(matchedAt)
        matchResolve = null
      }

      try {
        watcher = deps.start((info) => {
          if (cancelled) return
          if (!baselineSeen) {
            baselineSeen = true
            readyResolve(true)
            return
          }
          if (info.windowId === bundleId) {
            matchedAt = true
            matchResolve?.(true)
            matchResolve = null
          }
        })
      } catch {
        stop()
        return { ready: () => readyPromise, matched: () => Promise.resolve(false), cancel: stop }
      }
      timers.push(
        setTimeout(() => {
          // A baseline that arrives after the launch may already have been preceded by the activation: not evidence.
          if (!baselineSeen) cancelled = true
          readyResolve(baselineSeen)
        }, deps.readyTimeoutMs ?? READY_TIMEOUT_MS)
      )

      return {
        ready: () => readyPromise,
        matched() {
          if (matchedAt) return Promise.resolve(true)
          if (cancelled || !baselineSeen) return Promise.resolve(false)
          return new Promise<boolean>((resolve) => {
            matchResolve = resolve
            timers.push(
              setTimeout(() => {
                matchResolve = null
                resolve(matchedAt)
              }, windowMs)
            )
          })
        },
        cancel: stop
      }
    }
  }
}
