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
import { ownerCommand, type ContextRecord } from '@shared/context-authority'
import { VoiceAskSchema, type VoiceAsk } from '@shared/voice/voice-turn'
import {
  createVoiceActionExecutor,
  type VoiceActionExecutorDeps,
  type VoiceActionResult
} from './voice-action-executor'
import { createVoiceRouter, type VoiceRouterDeps } from './voice-router'
import type { VoiceTurnClaim } from './voice-session'

export type VoiceTurnOutcome =
  | { kind: 'action'; result: VoiceActionResult }
  | { kind: 'ask'; delivered: boolean }
  | { kind: 'cancelled' }
  | { kind: 'incomplete'; missing: 'title' | 'query' | 'too_long' }
  | { kind: 'unsupported' }
  | { kind: 'stale' }

export interface VoiceTurnPipelineDeps {
  router: VoiceRouterDeps
  executor: VoiceActionExecutorDeps
  /** Push a recognized question to the renderer, which runs it through the same router as a typed submit. */
  sendAsk(ask: VoiceAsk): void
  onOutcome?(outcome: VoiceTurnOutcome): void
  audit?(event: 'voice.action', data: Record<string, string>): void
}

export interface VoiceTurnPipeline {
  /** Fire and forget: a failure is reported as an outcome, never thrown into the capture. */
  handle(input: string | ContextRecord, claim: VoiceTurnClaim): void
  /** The same, awaitable. Used by tests and by `handle`. */
  run(input: string | ContextRecord, claim: VoiceTurnClaim): Promise<VoiceTurnOutcome>
}

export function createVoiceTurnPipeline(deps: VoiceTurnPipelineDeps): VoiceTurnPipeline {
  const router = createVoiceRouter(deps.router)
  const executor = createVoiceActionExecutor({ ...deps.executor, audit: deps.executor.audit ?? deps.audit })
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
    const route = await router.route(record)
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
      case 'incomplete':
        audit('incomplete')
        return { kind: 'incomplete', missing: route.missing }
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
    handle(input, claim) {
      run(input, claim).then(report, () => report({ kind: 'stale' }))
    }
  }
}
