import { randomBytes, timingSafeEqual } from 'node:crypto'
import { isDesktopAdapterId, type DesktopActionRequest, type DesktopActionResult } from '@shared/desktop-actions'

export const COMMAND_PROPOSAL_TTL_MS = 10_000

export type CommandControlProposal = { proposalId: string; nonce: string }
export type CommandControlState =
  | { proposalId: null }
  | { proposalId: string; nonce: string; expiresAt: number; revision: number }
export type CommandControlReason =
  | 'proposal_missing'
  | 'owner_mismatch'
  | 'proposal_mismatch'
  | 'nonce_mismatch'
  | 'expired'
  | 'policy_denied'
  | 'outcome_unverified'
  | 'adapter_failed'

type CurrentProposal = CommandControlProposal & {
  ownerWebContentsId: number
  revision: number
  request: DesktopActionRequest
  expiresAt: number
}

type CommandControlDeps = {
  execute: (request: DesktopActionRequest) => Promise<DesktopActionResult>
  policyAllows?: (request: DesktopActionRequest) => boolean
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
    request: DesktopActionRequest
  ): CommandControlProposal {
    this.clearCurrent()
    const proposal = {
      proposalId: randomBytes(16).toString('hex'),
      nonce: randomBytes(32).toString('hex')
    }
    this.current = {
      ...proposal,
      ownerWebContentsId: owner.webContentsId,
      revision: owner.revision,
      request,
      expiresAt: this.now() + this.ttlMs
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
      expiresAt: proposal.expiresAt,
      revision: proposal.revision
    }
  }

  async confirm(
    input: CommandControlProposal & { webContentsId: number }
  ): Promise<{ ok: true; outcome: DesktopActionResult['outcome'] } | { ok: false; reason: CommandControlReason }> {
    const proposal = this.validate(input)
    if ('reason' in proposal) return proposal
    // Consume before yielding to the adapter, so a double click or replay cannot execute twice.
    this.clearCurrent()
    this.emit()
    if (!isDesktopAdapterId(proposal.request.id) || this.deps.policyAllows?.(proposal.request) === false) {
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'policy_denied' })
      return { ok: false, reason: 'policy_denied' }
    }
    try {
      const result = await this.deps.execute(proposal.request)
      if (result.id !== proposal.request.id) {
        this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'failed' })
        return { ok: false, reason: 'adapter_failed' }
      }
      this.audit('command.confirmed', { actionId: proposal.request.id, outcome: result.outcome })
      if (result.ok && result.outcome === 'verified') return { ok: true, outcome: result.outcome }
      if (result.ok && result.outcome === 'unknown') return { ok: false, reason: 'outcome_unverified' }
      return { ok: false, reason: 'adapter_failed' }
    } catch {
      this.audit('command.confirmed', { actionId: proposal.request.id, outcome: 'failed' })
      return { ok: false, reason: 'adapter_failed' }
    }
  }

  async cancel(
    input: CommandControlProposal & { webContentsId: number }
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

  private validate(input: CommandControlProposal & { webContentsId: number }): CurrentProposal | { ok: false; reason: CommandControlReason } {
    const proposal = this.current
    if (!proposal) return { ok: false, reason: 'proposal_missing' }
    if (input.webContentsId !== proposal.ownerWebContentsId) return { ok: false, reason: 'owner_mismatch' }
    if (input.proposalId !== proposal.proposalId) return { ok: false, reason: 'proposal_mismatch' }
    if (!secureEqual(input.nonce, proposal.nonce)) return { ok: false, reason: 'nonce_mismatch' }
    if (this.now() >= proposal.expiresAt) {
      this.clearCurrent()
      this.emit()
      this.audit('command.revoked', { actionId: proposal.request.id, reason: 'expired' })
      return { ok: false, reason: 'expired' }
    }
    return proposal
  }

  private armExpiry(proposal: CurrentProposal): void {
    this.expiryTimer = setTimeout(() => {
      if (this.current?.proposalId !== proposal.proposalId) return
      this.revokeForLifecycleEvent('expired')
    }, Math.max(0, proposal.expiresAt - this.now()))
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
