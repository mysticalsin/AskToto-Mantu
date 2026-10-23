/**
 * The focus-request step (G40, CAP-24): the separate decision before Métis takes foreground control.
 *
 * Approving an action is not agreeing to let Métis drive another app's input. A foreground-only adapter
 * (src/shared/voice/adapter-capabilities.ts) therefore passes through this step after the action was approved and
 * before anything is dispatched: remember the app in front, preflight the permissions, ask a distinct question, then
 * arm Escape release. It has its own audit event and its own refusal copy. A standing grant never replaces it unless
 * the owner policy explicitly says so, and even then only for a request that actually ran through a grant.
 *
 * Everything OS-facing is injected. Audit metadata is the action id and closed enums; never arguments or app titles.
 */
import type { DesktopActionRequest } from '@shared/desktop-actions'
import type { EscapeRelease, ForegroundHold } from './escape-release'

export type FocusRefusalReason =
  | 'focus_preflight_failed'
  | 'focus_declined'
  | 'focus_unavailable'
  | 'focus_stopped'
  | 'escape_unavailable'

export const FOCUS_REFUSAL_COPY: Readonly<Record<Exclude<FocusRefusalReason, 'focus_preflight_failed'>, string>> = {
  focus_declined: 'You chose not to let Métis take control of the screen, so nothing was run.',
  focus_unavailable: 'Métis could not ask to take control of the screen just now, so nothing was run.',
  focus_stopped: 'This was stopped before Métis took control, so nothing was run.',
  escape_unavailable:
    'Métis could not set up the Escape key to give control back, so it did not take control. Nothing was run.'
}

export type FocusDecision = 'granted' | 'declined'
export type FocusPreflightResult = { ok: true } | { ok: false; code: string; copy: string }

export interface FocusRequestDeps {
  /** Remember the app in front now (before the question takes focus). */
  capturePrevious(): void
  /** Bring that app back. Bounded by the Escape release deadline. */
  restoreFocus(): Promise<void>
  /** The permission and target preflight for this request (V04). */
  preflight(request: DesktopActionRequest): Promise<FocusPreflightResult>
  /** The distinct question. It must resolve declined when it cannot be asked or when the signal aborts. */
  decide(input: { actionId: string }, signal: AbortSignal): Promise<FocusDecision>
  /** Owner policy. Default false: a grant never skips the decision. */
  grantMaySkip?(): boolean
  escape: EscapeRelease
  audit(event: 'task.focus_requested', metadata: Record<string, string>): void
}

export interface FocusRequestInput {
  /** The approval for this dispatch came from a standing grant rather than the confirm card. */
  viaGrant: boolean
  /** Aborts when Stop reaches the task. */
  signal: AbortSignal
  /** Stops this step (what Escape does). */
  stop(): void
}

export type FocusStepResult =
  | { ok: true; hold: ForegroundHold | null }
  | { ok: false; reason: FocusRefusalReason; copy: string }

export interface FocusRequestStep {
  run(request: DesktopActionRequest, input: FocusRequestInput): Promise<FocusStepResult>
}

export function createFocusRequestStep(deps: FocusRequestDeps): FocusRequestStep {
  return {
    async run(request, input) {
      const actionId = request.id
      const viaGrant = input.viaGrant ? 'yes' : 'no'
      const record = (decision: string): void => {
        try {
          deps.audit('task.focus_requested', { actionId, decision, viaGrant })
        } catch {
          /* audit is best effort */
        }
      }
      const refuse = (
        reason: Exclude<FocusRefusalReason, 'focus_preflight_failed'>,
        decision: string
      ): FocusStepResult => {
        record(decision)
        return { ok: false, reason, copy: FOCUS_REFUSAL_COPY[reason] }
      }

      try {
        deps.capturePrevious()
      } catch {
        /* the previous app is best effort; Escape still releases */
      }
      let preflight: FocusPreflightResult
      try {
        preflight = await deps.preflight(request)
      } catch {
        return refuse('focus_unavailable', 'unavailable')
      }
      if (!preflight.ok) {
        record('preflight_failed')
        return { ok: false, reason: 'focus_preflight_failed', copy: preflight.copy }
      }
      if (input.signal.aborted) return refuse('focus_stopped', 'stopped')

      let decision: FocusDecision | 'skipped'
      if (input.viaGrant && deps.grantMaySkip?.() === true) {
        decision = 'skipped'
      } else {
        try {
          decision = await deps.decide({ actionId }, input.signal)
        } catch {
          return refuse('focus_unavailable', 'unavailable')
        }
      }
      if (input.signal.aborted) return refuse('focus_stopped', 'stopped')
      if (decision === 'declined') return refuse('focus_declined', 'declined')

      const hold = deps.escape.hold({ actionId, stop: input.stop, restoreFocus: deps.restoreFocus })
      if (!hold) return refuse('escape_unavailable', 'escape_unavailable')
      record(decision === 'skipped' ? 'skipped_by_owner_policy' : 'granted')
      return { ok: true, hold }
    }
  }
}
