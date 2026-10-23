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
import type { GrantedRunDecision } from '../features/grants'
import type { VoiceTurnClaim } from './voice-session'

export type VoiceFailureReason =
  | 'automation_denied'
  | 'accessibility_required'
  | 'preferred_missing'
  | 'documents_unavailable'
  | 'unsupported'
  | 'task_unavailable'
  /** G34: another app was in front at dispatch than when the gesture started. Nothing ran. */
  | 'target_changed'
  /** G34: the request addressed someone main could not resolve from trusted UI state. Nothing ran. */
  | 'recipient_unresolved'
  | 'adapter_failed'

export type VoiceRefusalReason =
  | 'unsupported_platform'
  | 'invalid_request'
  | 'meeting_recording'
  | 'turn_ended'
  | 'not_allowed'
  /** G31: the purchase decision said no. Nothing ran. */
  | 'quota_exhausted'
  | 'quota_unavailable'
  /** G31: the operating system permission decision said no. Nothing ran. */
  | 'permission_needed'

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
  | {
      status: 'refused'
      reason: VoiceRefusalReason
      actionId?: DesktopActionRequest['id']
      /** G31: which separate decision refused, with its fixed copy. Absent for gate and platform refusals. */
      decision?: 'purchase' | 'permission'
      copy?: string
    }

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
  /**
   * G31 standing grants. Only a request the user's own spoken or typed command produced reaches the executor (the
   * voice router refuses content-origin records, G36), and a grant can only skip the card for a grantable class from
   * a trusted source. Absent means every confirm-class action asks, as before.
   */
  grants?: {
    decide(request: DesktopActionRequest, source: VoiceTurnSource): Promise<GrantedRunDecision>
    use(grantId: string): boolean
  }
}

export interface VoiceActionExecutor {
  handle(request: DesktopActionRequest, claim: VoiceTurnClaim, source: VoiceTurnSource): Promise<VoiceActionResult>
}

const FAILURE_DETAILS: Readonly<Record<string, VoiceFailureReason>> = {
  'task_denied:target_changed': 'target_changed',
  'task_denied:recipient_unresolved': 'recipient_unresolved',
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
    actionClass: VoiceActionClass,
    grantId?: string
  ): Promise<VoiceActionResult> {
    const owner = deps.owner()
    const refusal = owner ? gateRefusal(claim) : 'not_allowed'
    if (refusal) return { status: 'refused', reason: refusal, actionId: request.id }
    // A grant is taken only after the gate passed and just before the turn: no await between the three.
    if (grantId !== undefined && !deps.grants?.use(grantId)) return needConfirmation(request, claim, actionClass)
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
        dependsOn: [],
        ...(grantId !== undefined ? { viaGrant: true } : {})
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

  const REFUSAL_REASON = {
    quota_exhausted: 'quota_exhausted',
    quota_unavailable: 'quota_unavailable',
    permission_denied: 'permission_needed'
  } as const

  /** Ask the grant service; any failure of it means the card, never a silent run. */
  async function grantDecision(
    request: DesktopActionRequest,
    source: VoiceTurnSource
  ): Promise<GrantedRunDecision | null> {
    if (!deps.grants) return null
    try {
      return await deps.grants.decide(request, source)
    } catch {
      return null
    }
  }

  return {
    async handle(rawRequest, claim, source) {
      const request = validateDesktopRequest(rawRequest)
      if (!request) return { status: 'refused', reason: 'invalid_request' }
      const actionClass = classifyDesktopRequest(request, platform)
      const decision = decideVoiceAction(actionClass, source)
      let result: VoiceActionResult
      let grantedRun = false
      if (decision === 'refuse' || actionClass === null) {
        result = { status: 'refused', reason: 'unsupported_platform', actionId: request.id }
      } else if (decision === 'confirm') {
        let granted: GrantedRunDecision | null = null
        // The gate is read first so a recording meeting or an ended turn never probes purchase or permission.
        if (deps.grants && deps.owner() && !gateRefusal(claim)) granted = await grantDecision(request, source)
        if (granted?.outcome === 'run') {
          grantedRun = true
          result = await runImmediate(request, claim, actionClass, granted.grant.grantId)
        } else if (granted?.outcome === 'refuse') {
          const reason = REFUSAL_REASON[granted.refusal.reason as keyof typeof REFUSAL_REASON] ?? 'not_allowed'
          result = {
            status: 'refused',
            reason,
            actionId: request.id,
            decision: granted.refusal.decision === 'purchase' ? 'purchase' : 'permission',
            copy: granted.refusal.copy
          }
        } else {
          result = await needConfirmation(request, claim, actionClass)
        }
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
        ...(grantedRun ? { via: 'grant' } : {}),
        ...(result.status === 'refused' || result.status === 'failed' ? { reason: result.reason } : {})
      })
      return result
    }
  }
}
