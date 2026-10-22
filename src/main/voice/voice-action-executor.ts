/**
 * Voice action executor (V03): what happens to one recognized action request.
 *
 * It applies the policy and returns a typed result. Nothing here renders anything.
 *
 *   run      read and reversible actions, from a hardware-activated hold, run at once. They go through the same
 *            durable task bridge as a confirmed command: one task per dispatch, persisted as `dispatching`
 *            before the adapter runs, an uncertain outcome reported and never replayed. The gate is the
 *            confirmation policy minus "the owner window is focused", replaced by "this turn has not been
 *            revoked". The turn claim is single use, so one hold yields at most one run.
 *   confirm  create, send, type and delete actions (and everything from a wake word or the panel) become a
 *            pending proposal in CommandControl and the result says so (`needs_confirmation`). Approving it is
 *            the existing `confirmMetisCommand` path with its nonce, TTL and args hash. This module never
 *            confirms anything itself.
 *   refuse   an action the platform cannot run.
 *
 * An executed action ends one of three ways: `done` (a verified outcome backed by a receipt bound to this
 * dispatch: the observed-receipt rule), `uncertain` (the effect may have happened and could not be proven: the
 * person is told to check, and Métis never retries it), or `failed` (the adapter proved nothing happened).
 */
import { randomBytes } from 'node:crypto'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import {
  classifyDesktopRequest,
  previewFor,
  validateDesktopRequest,
  verificationFor,
  voicePlatformOf,
  type VoiceActionClass,
  type VoiceActionPreview,
  type VoiceVerification
} from '@shared/voice/catalog'
import {
  decideVoiceAction,
  voiceImmediateRunAllowed,
  type VoiceImmediateRunInput,
  type VoiceTurnSource
} from '@shared/voice/voice-action-policy'
import { actionEnvelope, isObservedVerified } from '../action-guard'
import type { CommandControlProposal, CommandExecutor } from '../command-control'
import type { VoiceTurnClaim } from './voice-session'

export type VoiceFailureReason =
  | 'automation_denied'
  | 'accessibility_required'
  | 'preferred_missing'
  | 'documents_unavailable'
  | 'unsupported'
  | 'task_unavailable'
  | 'adapter_failed'

export type VoiceRefusalReason =
  | 'unsupported_platform'
  | 'invalid_request'
  | 'meeting_recording'
  | 'turn_ended'
  | 'not_allowed'

export type VoiceActionResult =
  | {
      status: 'needs_confirmation'
      actionId: DesktopActionRequest['id']
      actionClass: VoiceActionClass
      proposalId: string
      argsHash: string
      preview: VoiceActionPreview
    }
  | { status: 'done'; actionId: DesktopActionRequest['id']; actionClass: VoiceActionClass }
  | {
      status: 'uncertain'
      actionId: DesktopActionRequest['id']
      actionClass: VoiceActionClass
      /** `handoff`: handed to the system, nothing to read back. `readback`: it should have been provable and was not. */
      verification: VoiceVerification
    }
  | {
      status: 'failed'
      actionId: DesktopActionRequest['id']
      actionClass: VoiceActionClass
      reason: VoiceFailureReason
    }
  | { status: 'refused'; reason: VoiceRefusalReason; actionId?: DesktopActionRequest['id'] }

export interface VoiceActionExecutorDeps {
  platform: NodeJS.Platform | string
  /** The durable dispatch (the task bridge's executor). Every immediate run goes through it. */
  execute: CommandExecutor
  /**
   * Create the pending proposal in CommandControl, through its preflight (V04), so the card, its Return guard, TTL
   * and focus restore apply to a spoken create exactly as to a panel one. Null when there is no owner window to
   * confirm in or the preflight refused (the person then already has the honest sentence: a notice).
   */
  propose(request: DesktopActionRequest): CommandControlProposal | null | Promise<CommandControlProposal | null>
  /** The owner window as main knows it (never renderer supplied), for the task's owner binding. */
  owner(): { webContentsId: number; revision: number } | null
  /** Live main state for the gate, read at the moment of the decision. */
  gate(): Omit<VoiceImmediateRunInput, 'turnCurrent'>
  audit?(event: 'voice.action', data: Record<string, string>): void
  newProposalId?(): string
}

export interface VoiceActionExecutor {
  handle(request: DesktopActionRequest, claim: VoiceTurnClaim, source: VoiceTurnSource): Promise<VoiceActionResult>
}

const FAILURE_DETAILS: Readonly<Record<string, VoiceFailureReason>> = {
  automation_denied: 'automation_denied',
  accessibility_required: 'accessibility_required',
  preferred_missing: 'preferred_missing',
  documents_unavailable: 'documents_unavailable',
  note_folder_unavailable: 'documents_unavailable',
  note_name_unavailable: 'documents_unavailable'
}

function failureReason(result: DesktopActionResult): VoiceFailureReason {
  if (result.preferredMissing) return 'preferred_missing'
  const known = result.detail ? FAILURE_DETAILS[result.detail] : undefined
  if (known) return known
  if (result.detail?.startsWith('task_denied:') || result.detail === 'task_bridge_error') return 'task_unavailable'
  return result.outcome === 'unsupported' ? 'unsupported' : 'adapter_failed'
}

export function createVoiceActionExecutor(deps: VoiceActionExecutorDeps): VoiceActionExecutor {
  const platform = voicePlatformOf(deps.platform)
  const newProposalId = deps.newProposalId ?? (() => randomBytes(16).toString('hex'))
  const audit = (data: Record<string, string>): void => {
    try {
      deps.audit?.('voice.action', data)
    } catch {
      /* audit is best effort */
    }
  }

  /** The first reason the gate says no, or null when it says yes. Read once, then used for the decision. */
  function gateRefusal(claim: VoiceTurnClaim): VoiceRefusalReason | null {
    const live = deps.gate()
    const input: VoiceImmediateRunInput = { ...live, turnCurrent: claim.valid() }
    if (voiceImmediateRunAllowed(input)) return null
    if (input.meetingReserved) return 'meeting_recording'
    if (!input.turnCurrent) return 'turn_ended'
    return 'not_allowed'
  }

  async function runImmediate(
    request: DesktopActionRequest,
    claim: VoiceTurnClaim,
    actionClass: VoiceActionClass
  ): Promise<VoiceActionResult> {
    const owner = deps.owner()
    const refusal = owner ? gateRefusal(claim) : 'not_allowed'
    if (refusal) return { status: 'refused', reason: refusal, actionId: request.id }
    // Single use, taken synchronously with the check above: no await between them.
    if (!claim.consume()) return { status: 'refused', reason: 'turn_ended', actionId: request.id }
    const proposalId = newProposalId()
    const envelope = actionEnvelope(proposalId, request)
    let result: DesktopActionResult
    try {
      result = await deps.execute(request, {
        proposalId,
        owner: owner as { webContentsId: number; revision: number },
        ...envelope,
        dependsOn: []
      })
    } catch {
      // The adapter was already invoked: a rejection does not prove the effect did not happen.
      return {
        status: 'uncertain',
        actionId: request.id,
        actionClass,
        verification: verificationFor(request, platform)
      }
    }
    if (result.id !== request.id) {
      return { status: 'failed', actionId: request.id, actionClass, reason: 'adapter_failed' }
    }
    // Observed-receipt rule: `verified` counts only with readback bound to this dispatch.
    if (isObservedVerified(request, result, envelope)) return { status: 'done', actionId: request.id, actionClass }
    if (result.outcome === 'unknown' || result.outcome === 'verified') {
      return {
        status: 'uncertain',
        actionId: request.id,
        actionClass,
        verification: verificationFor(request, platform)
      }
    }
    return { status: 'failed', actionId: request.id, actionClass, reason: failureReason(result) }
  }

  async function needConfirmation(
    request: DesktopActionRequest,
    claim: VoiceTurnClaim,
    actionClass: VoiceActionClass
  ): Promise<VoiceActionResult> {
    const refusal = deps.owner() ? gateRefusal(claim) : 'not_allowed'
    if (refusal) return { status: 'refused', reason: refusal, actionId: request.id }
    if (!claim.consume()) return { status: 'refused', reason: 'turn_ended', actionId: request.id }
    let proposal: CommandControlProposal | null = null
    try {
      proposal = await deps.propose(request)
    } catch {
      proposal = null
    }
    if (!proposal) return { status: 'refused', reason: 'not_allowed', actionId: request.id }
    return {
      status: 'needs_confirmation',
      actionId: request.id,
      actionClass,
      proposalId: proposal.proposalId,
      argsHash: proposal.argsHash,
      preview: previewFor(request, platform)
    }
  }

  return {
    async handle(rawRequest, claim, source) {
      const request = validateDesktopRequest(rawRequest)
      if (!request) return { status: 'refused', reason: 'invalid_request' }
      const actionClass = classifyDesktopRequest(request, platform)
      const decision = decideVoiceAction(actionClass, source)
      let result: VoiceActionResult
      if (decision === 'refuse' || actionClass === null) {
        result = { status: 'refused', reason: 'unsupported_platform', actionId: request.id }
      } else if (decision === 'confirm') {
        result = await needConfirmation(request, claim, actionClass)
      } else {
        result = await runImmediate(request, claim, actionClass)
      }
      // Metadata only: the action id, its class and how it ended. Never a title, a query or any spoken text.
      audit({
        actionId: request.id,
        class: actionClass ?? 'none',
        source,
        decision,
        status: result.status,
        ...(result.status === 'refused' || result.status === 'failed' ? { reason: result.reason } : {})
      })
      return result
    }
  }
}
