/**
 * Escape release (G40, CAP-24): while Métis holds foreground control for a task step, Escape gives control back.
 *
 * The hold arms a global Escape source for the length of the step only. On Escape it does three things in this
 * order: stop the step now (synchronously: the step lease aborts, so the adapter sees its AbortSignal), disarm, then
 * return focus to the app that was in front, bounded by a deadline. Stopping cannot undo an effect already in
 * flight: the step still settles through its receipt, so an effect that cannot be proven stays `uncertain`.
 *
 * If Escape cannot be armed there is no hold at all (null): control that cannot be given back is not taken.
 * Time and timers are injected. No key text is ever recorded.
 */
export const ESCAPE_RELEASE_DEADLINE_MS = 300 // PROPOSED

/** The global Escape listener. `arm` returns how to stop listening, or null when Escape cannot be listened for. */
export interface EscapeKeySource {
  arm(onEscape: () => void): (() => void) | null
}

export interface EscapeReleaseReport {
  withinDeadline: boolean
  focus: 'restored' | 'timed_out' | 'failed'
  elapsedMs: number
}

export interface ForegroundHold {
  /** The step ended on its own. Stops listening. Safe to call more than once. */
  end(): void
  /** Settles with a report after Escape released control. Never settles when the hold simply ends. */
  readonly escaped: Promise<EscapeReleaseReport>
}

export interface EscapeHoldSpec {
  actionId: string
  /** Stops the step (aborts its lease). Must be synchronous in effect. */
  stop(): void
  /** Return focus to the app that was in front before control was taken. */
  restoreFocus(): Promise<void>
}

export interface EscapeRelease {
  hold(spec: EscapeHoldSpec): ForegroundHold | null
}

export interface EscapeReleaseDeps {
  source: EscapeKeySource
  /** Monotonic milliseconds. */
  now(): number
  timers: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
  audit(event: 'task.escape_release', metadata: Record<string, string>): void
  deadlineMs?: number
}

export function createEscapeRelease(deps: EscapeReleaseDeps): EscapeRelease {
  const deadlineMs = deps.deadlineMs ?? ESCAPE_RELEASE_DEADLINE_MS
  return {
    hold(spec) {
      let finished = false
      let disarm: (() => void) | null = null
      let resolveEscaped: (report: EscapeReleaseReport) => void = () => undefined
      const escaped = new Promise<EscapeReleaseReport>((resolve) => {
        resolveEscaped = resolve
      })
      const stopListening = (): void => {
        const stop = disarm
        disarm = null
        try {
          stop?.()
        } catch {
          /* the listener is already gone */
        }
      }
      const onEscape = (): void => {
        if (finished) return
        finished = true
        const startedAt = deps.now()
        try {
          spec.stop()
        } catch {
          // The step may already be over; focus still goes back.
        }
        stopListening()
        let timer: unknown = null
        const deadline = new Promise<'timed_out'>((resolve) => {
          timer = deps.timers.set(() => resolve('timed_out'), deadlineMs)
        })
        const restore = (async () => {
          try {
            await spec.restoreFocus()
            return 'restored' as const
          } catch {
            return 'failed' as const
          }
        })()
        void Promise.race([restore, deadline]).then((focus) => {
          deps.timers.clear(timer)
          const elapsedMs = Math.max(0, deps.now() - startedAt)
          const report: EscapeReleaseReport = {
            withinDeadline: focus !== 'timed_out' && elapsedMs <= deadlineMs,
            focus,
            elapsedMs
          }
          try {
            deps.audit('task.escape_release', {
              actionId: spec.actionId,
              withinDeadline: report.withinDeadline ? 'yes' : 'no',
              focus: report.focus
            })
          } catch {
            /* audit is best effort */
          }
          resolveEscaped(report)
        })
      }
      disarm = deps.source.arm(onEscape)
      if (!disarm) return null
      return {
        end() {
          if (finished) return
          finished = true
          stopListening()
        },
        escaped
      }
    }
  }
}
