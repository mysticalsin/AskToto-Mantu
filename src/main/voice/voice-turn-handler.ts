/**
 * Voice turn handler (V03): the recognized text of one hold goes in, a typed outcome comes out.
 *
 * It routes the text (voice-router), then either hands an action to the executor (policy, durable dispatch or a
 * pending proposal), sends a question to the renderer's typed Ask path, or reports why nothing happened. It owns
 * no state and renders nothing: V04 and V05 subscribe to `onOutcome` for the card and the pill. A turn claim is
 * single use and dies on any revocation, and every branch that does something takes it first.
 *
 * Privacy: the text lives in this call only. The audit event carries a status and a class, never words.
 */
import { mayProposeActions, ownerCommand, type ContextRecord } from '@shared/context-authority'
import type { WalkthroughView } from '@shared/walkthrough-view'
import { parseWalkthroughIntent, type WalkthroughIntent } from '../features/walkthrough/walkthrough-intent'
import { VoiceAskSchema, type VoiceAsk } from '@shared/voice/voice-turn'
import {
  createVoiceActionExecutor,
  type VoiceActionExecutorDeps,
  type VoiceActionResult
} from './voice-action-executor'
import type { ClarifyEndReason, ClarifyAction } from '@shared/clarify-copy'
import {
  CLARIFY_PREPARATION,
  clarifiableAction,
  createClarifyMachine,
  isSafePreparation,
  type ClarifyBinding,
  type ClarifyDropReason
} from './clarify-protocol'
import { createVoiceRouter, type VoiceRoute, type VoiceRouterDeps } from './voice-router'
import type { VoiceTurnClaim } from './voice-session'

export type VoiceTurnOutcome =
  | { kind: 'action'; result: VoiceActionResult }
  | { kind: 'ask'; delivered: boolean }
  | { kind: 'cancelled' }
  | { kind: 'incomplete'; missing: 'title' | 'query' | 'too_long' }
  | { kind: 'unsupported' }
  | { kind: 'stale' }
  /** G35: the one question. `prepared` is the read-only or reversible work done first, if any. */
  | { kind: 'clarify'; question: string; action: ClarifyAction; prepared: VoiceActionResult | null }
  /** G35: the question is over and nothing was done; `copy` says so. */
  | { kind: 'clarify_ended'; reason: ClarifyEndReason; copy: string }
  /** G44: a walkthrough intent (start, check, pause, resume, stop) was handled; `view` is the renderer-safe state. */
  | { kind: 'walkthrough'; status: string; view: WalkthroughView }

export interface VoiceTurnPipelineDeps {
  router: VoiceRouterDeps
  executor: VoiceActionExecutorDeps
  /** Push a recognized question to the renderer, which runs it through the same router as a typed submit. */
  sendAsk(ask: VoiceAsk): void
  onOutcome?(outcome: VoiceTurnOutcome): void
  /**
   * G35. Present: an incomplete request becomes one clarifying question and the next owner turn is its answer.
   * `binding` is the live owner, session and task lineage (null when main cannot name one: no question is asked).
   */
  clarify?: { binding(): ClarifyBinding | null; now?(): number; ttlMs?: number }
  /**
   * G44, CAP-25. Present and `enabled()`: "walk me through ..." starts a guided walkthrough, and while one is live
   * done/next/pause/resume/stop steer it. Owner commands only; the walkthrough guides and never acts for the owner.
   */
  walkthrough?: {
    enabled(): boolean
    active(): boolean
    handle(intent: WalkthroughIntent): Promise<{ status: string; view: WalkthroughView }>
  }
  audit?(event: 'voice.action', data: Record<string, string>): void
}

export interface VoiceTurnPipeline {
  /** Fire and forget: a failure is reported as an outcome, never thrown into the capture. */
  handle(input: string | ContextRecord, claim: VoiceTurnClaim): void
  /** The same, awaitable. Used by tests and by `handle`. */
  run(input: string | ContextRecord, claim: VoiceTurnClaim): Promise<VoiceTurnOutcome>
  /** Stop, sign-out, an owner switch or a meeting starting: the pending clarification is gone. */
  dropClarification(reason: ClarifyDropReason): void
}

export function createVoiceTurnPipeline(deps: VoiceTurnPipelineDeps): VoiceTurnPipeline {
  const router = createVoiceRouter(deps.router)
  const executor = createVoiceActionExecutor({ ...deps.executor, audit: deps.executor.audit ?? deps.audit })
  const clarify = deps.clarify
    ? createClarifyMachine({ now: deps.clarify.now ?? Date.now, ttlMs: deps.clarify.ttlMs })
    : null
  const audit = (status: string): void => {
    try {
      deps.audit?.('voice.action', { source: 'push-to-talk', status })
    } catch {
      /* best effort */
    }
  }

  async function run(input: string | ContextRecord, claim: VoiceTurnClaim): Promise<VoiceTurnOutcome> {
    // Bare text arrives only from the main-owned hold capture, beside the claim main minted from a hardware
    // activation: that is the owner speaking. Anything tagged as content is routed by its own tag (R124).
    const record = typeof input === 'string' ? ownerCommand('user-spoken-by-owner', input) : input
    let route: VoiceRoute | null = null
    if (clarify?.pending()) {
      const answer = clarify.answer(record, deps.clarify?.binding() ?? null)
      if (answer.kind === 'complete') {
        // The answer only fills the missing slot: the request still takes the normal executor and confirm path.
        route = { kind: 'action', request: answer.request, via: 'grammar' }
        audit('clarify_answered')
      } else if (answer.kind === 'ended') {
        audit(`clarify_${answer.reason}`)
        return { kind: 'clarify_ended', reason: answer.reason, copy: answer.copy }
      }
    }
    if (route === null && deps.walkthrough?.enabled() && mayProposeActions(record)) {
      const intent = parseWalkthroughIntent(record.text, { active: deps.walkthrough.active() })
      if (intent) {
        // The claim is spent before anything starts, like an Ask: one hold, one effect.
        if (!claim.valid() || !claim.consume()) {
          audit('stale')
          return { kind: 'stale' }
        }
        const handled = await deps.walkthrough.handle(intent)
        audit(`walkthrough_${intent.kind}`)
        return { kind: 'walkthrough', status: handled.status, view: handled.view }
      }
    }
    route ??= await router.route(record)
    // Whatever was recognised, nothing continues for a turn that was revoked while the router worked.
    if (!claim.valid()) {
      audit('stale')
      return { kind: 'stale' }
    }
    switch (route.kind) {
      case 'action':
        return { kind: 'action', result: await executor.handle(route.request, claim, 'push-to-talk') }
      case 'ask': {
        if (!claim.consume()) return { kind: 'stale' }
        const ask = VoiceAskSchema.safeParse({ turnId: claim.turnId, text: route.text })
        let delivered = false
        if (ask.success) {
          try {
            deps.sendAsk(ask.data)
            delivered = true
          } catch {
            delivered = false
          }
        }
        audit(delivered ? 'ask' : 'ask_dropped')
        return { kind: 'ask', delivered }
      }
      case 'cancelled':
        audit('cancelled')
        return { kind: 'cancelled' }
      case 'incomplete': {
        const binding = clarify ? deps.clarify?.binding() : null
        const action = binding ? clarifiableAction(record.text) : null
        if (!clarify || !binding || !action) {
          audit('incomplete')
          return { kind: 'incomplete', missing: route.missing }
        }
        // Reversible preparation first (never anything that needs the missing detail), then exactly one question.
        const preparation = CLARIFY_PREPARATION[action]
        let prepared: VoiceActionResult | null = null
        if (preparation && isSafePreparation(preparation)) {
          prepared = await executor.handle(preparation, claim, 'push-to-talk')
          if (
            prepared.status === 'refused' &&
            (prepared.reason === 'meeting_recording' || prepared.reason === 'turn_ended')
          ) {
            return { kind: 'action', result: prepared }
          }
        }
        const opened = clarify.open({ action, missing: route.missing, binding })
        audit('clarify_asked')
        return { kind: 'clarify', question: opened.question, action, prepared }
      }
      case 'unsupported':
        audit('unsupported')
        return { kind: 'unsupported' }
      case 'no_authority':
        // Content is not a command. Nothing was proposed, asked or classified, and the claim is not spent.
        audit('no_authority')
        return { kind: 'unsupported' }
    }
  }

  const report = (outcome: VoiceTurnOutcome): void => {
    try {
      deps.onOutcome?.(outcome)
    } catch {
      /* a subscriber must not break the pipeline */
    }
  }

  return {
    run,
    dropClarification(reason) {
      if (clarify?.drop(reason)) audit(`clarify_dropped_${reason}`)
    },
    handle(input, claim) {
      run(input, claim).then(report, () => report({ kind: 'stale' }))
    }
  }
}
