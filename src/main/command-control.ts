import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isDesktopAdapterId, type DesktopActionRequest, type DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope, checkDependsOn, isArgsHash, isObservedVerified, type ActionEnvelope } from './action-guard'

export const COMMAND_PROPOSAL_TTL_MS = 10_000

/** The approval is the proposal id, the nonce and the hash of the exact request it authorizes (ActionGuard). */
export type CommandControlProposal = { proposalId: string; nonce: string; argsHash: string }
/** Cancelling authorizes nothing, so the id and nonce are enough. */
export type CommandControlCancellation = Omit<CommandControlProposal, 'argsHash'>
export type CommandControlState =
  | { proposalId: null }
  | { proposalId: string; nonce: string; argsHash: string; expiresAt: number; revision: number }
export type CommandControlReason =
  | 'proposal_missing'
  | 'owner_mismatch'
  | 'proposal_mismatch'
  | 'nonce_mismatch'
  | 'args_mismatch'
  | 'expired'
  | 'policy_denied'
  | 'outcome_unverified'
  | 'adapter_failed'

type CurrentProposal = CommandControlProposal & {
  ownerWebContentsId: number
  revision: number
  request: DesktopActionRequest
  expiresAt: number
  idempotencyKey: string
  dependsOn: readonly string[]
}

export type CommandConfirmationPolicyInput = {
  authenticated: boolean
  listenEntitled: boolean
  owner: { destroyed: boolean; visible: boolean; focused: boolean } | null
  onboardingExclusive: boolean
  lifecycleHooksReady: boolean
}

/** Pure gate for every non-in-app action. Missing trust or lifecycle state denies confirmation. */
export function commandConfirmationPolicyAllows(input: CommandConfirmationPolicyInput): boolean {
  return (
    input.authenticated &&
    input.listenEntitled &&
    input.owner !== null &&
    !input.owner.destroyed &&
    input.owner.visible &&
    input.owner.focused &&
    !input.onboardingExclusive &&
    input.lifecycleHooksReady
  )
}

/** What main knows about one confirmed proposal. The owner comes from the IPC sender, never the renderer payload. */
export type CommandExecutionContext = ActionEnvelope & {
  proposalId: string
  owner: { webContentsId: number; revision: number }
  /** Proposal ids that must already be verified. The durable task bridge enforces it. */
  dependsOn: readonly string[]
}

export type CommandExecutor = (
  request: DesktopActionRequest,
  context: CommandExecutionContext
) => Promise<DesktopActionResult>

type CommandControlDeps = {
  execute: CommandExecutor
  /** Main-process policy is required: omitting it must never turn confirmation into permission. */
  policyAllows: (request: DesktopActionRequest) => boolean
  audit?: (event: 'command.confirmed' | 'command.revoked', metadata: Record<string, string>) => void
  onState?: (state: CommandControlState) => void
  now?: () => number
  ttlMs?: number
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class CommandControl {
  private current: CurrentProposal | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: CommandControlDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? COMMAND_PROPOSAL_TTL_MS
  }

  propose(
    owner: { webContentsId: number; revision: number },
    request: DesktopActionRequest,
    options: { dependsOn?: readonly string[] } = {}
  ): CommandControlProposal {
    this.clearCurrent()
    const dependencies = checkDependsOn(options.dependsOn ?? [])
    if (!dependencies.ok) {
      this.emit()
      throw new Error(dependencies.reason)
    }
    // The proposal keeps a private snapshot. No caller that supplied the request can mutate what
    // the user later confirms, even if a future command source starts reusing request objects.
    const requestSnapshot = Object.freeze({
      ...request,
      args: Object.freeze({ ...request.args })
    }) as DesktopActionRequest
    const proposalId = randomBytes(16).toString('hex')
    const { argsHash, idempotencyKey } = actionEnvelope(proposalId, requestSnapshot)
    const proposal = { proposalId, nonce: randomBytes(32).toString('hex'), argsHash }
    this.current = {
      ...proposal,
      ownerWebContentsId: owner.webContentsId,
      revision: owner.revision,
      request: requestSnapshot,
      expiresAt: this.now() + this.ttlMs,
      idempotencyKey,
      dependsOn: dependencies.dependsOn
    }
    this.armExpiry(this.current)
    this.emit()
    return proposal
  }

  getState(): CommandControlState {
    const proposal = this.current
    if (!proposal) return { proposalId: null }
    return {
      proposalId: proposal.proposalId,
      nonce: proposal.nonce,
      argsHash: proposal.argsHash,
      expiresAt: proposal.expiresAt,
      revision: proposal.revision
    }
  }

  async confirm(
    input: CommandControlProposal & { webContentsId: number }
  ): Promise<{ ok: true; outcome: DesktopActionResult['outcome'] } | { ok: false; reason: CommandControlReason }> {
    const proposal = this.validate(input, { argsHash: input.argsHash })
    if ('reason' in proposal) return proposal
    // Consume before yielding to the adapter, so a double click or replay cannot execute twice.
    this.clearCurrent()
    this.emit()
    let allowed = false
    try {
      allowed = isDesktopAdapterId(proposal.request.id) && this.deps.policyAllows(proposal.request) === true
    } catch {
      // A broken or unavailable policy check is a denial, never an implicit allow.
      allowed = false
    }
    if (!allowed) {
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'policy_denied' })
      return { ok: false, reason: 'policy_denied' }
    }
    try {
      const envelope = { argsHash: proposal.argsHash, idempotencyKey: proposal.idempotencyKey }
      const result = await this.deps.execute(proposal.request, {
        proposalId: proposal.proposalId,
        owner: { webContentsId: proposal.ownerWebContentsId, revision: proposal.revision },
        ...envelope,
        dependsOn: proposal.dependsOn
      })
      if (result.id !== proposal.request.id) {
        this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'failed' })
        return { ok: false, reason: 'adapter_failed' }
      }
      // Observed-receipt rule: `verified` counts only with readback bound to this dispatch. A verified claim
      // without it is not evidence, and the effect may have happened, so it is reported unverified.
      const verified = result.ok && result.outcome === 'verified'
      const observed = verified && isObservedVerified(proposal.request, result, envelope)
      this.audit('command.confirmed', {
        actionId: proposal.request.id,
        outcome: verified && !observed ? 'unknown' : result.outcome
      })
      if (observed) return { ok: true, outcome: 'verified' }
      if (result.outcome === 'unknown' || verified) return { ok: false, reason: 'outcome_unverified' }
      return { ok: false, reason: 'adapter_failed' }
    } catch {
      // The adapter was already invoked: a rejection does not prove the effect did not happen (the app may have
      // launched before the acknowledgement was lost). Report it as unverified, never as a clean failure.
      this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'unknown' })
      return { ok: false, reason: 'outcome_unverified' }
    }
  }

  async cancel(
    input: CommandControlCancellation & { webContentsId: number }
  ): Promise<{ ok: true } | { ok: false; reason: CommandControlReason }> {
    const proposal = this.validate(input)
    if ('reason' in proposal) return proposal
    this.clearCurrent()
    this.emit()
    this.audit('command.revoked', { actionId: proposal.request.id, reason: 'cancelled' })
    return { ok: true }
  }

  revokeForLifecycleEvent(reason: string): void {
    const proposal = this.current
    if (!proposal) return
    this.clearCurrent()
    this.emit()
    this.audit('command.revoked', { actionId: proposal.request.id, reason })
  }

  /** A confirmation passes its claimed `argsHash` (even when absent): it must match the hash taken at propose time. */
  private validate(
    input: CommandControlCancellation & { webContentsId: number },
    confirmation?: { argsHash: unknown }
  ): CurrentProposal | { ok: false; reason: CommandControlReason } {
    const proposal = this.current
    if (!proposal) return { ok: false, reason: 'proposal_missing' }
    if (input.webContentsId !== proposal.ownerWebContentsId) return { ok: false, reason: 'owner_mismatch' }
    if (input.proposalId !== proposal.proposalId) return { ok: false, reason: 'proposal_mismatch' }
    if (!secureEqual(input.nonce, proposal.nonce)) return { ok: false, reason: 'nonce_mismatch' }
    if (confirmation && !(isArgsHash(confirmation.argsHash) && secureEqual(confirmation.argsHash, proposal.argsHash))) {
      return { ok: false, reason: 'args_mismatch' }
    }
    if (this.now() >= proposal.expiresAt) {
      this.clearCurrent()
      this.emit()
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'expired' })
      return { ok: false, reason: 'expired' }
    }
    return proposal
  }

  private armExpiry(proposal: CurrentProposal): void {
    this.expiryTimer = setTimeout(
      () => {
        if (this.current?.proposalId !== proposal.proposalId) return
        this.revokeForLifecycleEvent('expired')
      },
      Math.max(0, proposal.expiresAt - this.now())
    )
  }

  private clearCurrent(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer)
      this.expiryTimer = null
    }
    this.current = null
  }

  private emit(): void {
    this.deps.onState?.(this.getState())
  }

  private audit(event: 'command.confirmed' | 'command.revoked', metadata: Record<string, string>): void {
    this.deps.audit?.(event, metadata)
  }
}
