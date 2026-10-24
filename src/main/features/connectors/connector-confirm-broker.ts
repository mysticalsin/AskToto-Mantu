import { randomBytes, timingSafeEqual } from 'node:crypto'
import { COMMAND_RETURN_GUARD_MS } from '@shared/command-return-guard'
import type { ConnectorEffectClass } from '@shared/connector-effects'
import type {
  ConnectorConfirmCard,
  ConnectorConfirmDecision,
  ConnectorConfirmDecisionResponse,
  ConnectorConfirmState
} from '@shared/connector-confirm'
import { COMMAND_PROPOSAL_TTL_ASSISTIVE_MS } from '@shared/metis-command-contract'
import { scheduleConfirmDeadline, type ConfirmDeadlineScheduler } from '../../infra/scheduler/confirm-deadline'
import type { ConnectorApproval } from './connector-executor'

export type ConfirmOutcome =
  | { confirmed: true; approval: ConnectorApproval }
  | { confirmed: false; reason: 'cancelled' | 'expired' | 'revoked' | 'stale' }

export interface ConnectorConfirmRequest {
  ownerWebContentsId: number
  opId: string
  revision: number
  /** The hash of the exact arguments. The approval is bound to it. */
  argsHash: string
  effectClass: ConnectorEffectClass
  summary: string
  connectorLabel: string
  accountLabel?: string
  maskedHint?: string
  subjectPreview?: string
  /** Verified recipients only. */
  recipients?: readonly { address: string; source: string }[]
}

export interface ConnectorConfirmBrokerDeps {
  send(webContentsId: number, state: ConnectorConfirmState): void
  catalogRevision(): number
  audit?(event: string, metadata: Record<string, string | number | boolean>): void
  now?(): number
  ttlMs?: number
  minDecideDelayMs?: number
  schedule?: ConfirmDeadlineScheduler
}

export interface ConnectorConfirmBroker {
  /** Shows the card and waits. Resolves exactly once; nothing runs unless it resolves `confirmed: true`. */
  issue(request: ConnectorConfirmRequest): Promise<ConfirmOutcome>
  current(webContentsId: number): ConnectorConfirmState
  decide(input: ConnectorConfirmDecision & { webContentsId: number }): ConnectorConfirmDecisionResponse
  cancel(input: { webContentsId: number; proposalId: string; nonce: string }): boolean
  revokeAll(reason: string): void
}

interface Pending {
  card: ConnectorConfirmCard
  request: ConnectorConfirmRequest
  shownAt: number
  settle(outcome: ConfirmOutcome): void
  stopTimer(): void
}

const SETTLED_MEMORY = 256

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * The connector confirm card's main side (G64). Same rules as the account choice card and the voice confirmation:
 * an opaque proposal id and nonce, the hash of the exact request, a 30 s lifetime that only ever cancels, the 300 ms
 * return guard, owner-window binding and single use. The proposal id minted here is the ActionGuard approval's id.
 * One card per owner window; a newer card replaces (and cancels) the older one.
 */
export function createConnectorConfirmBroker(deps: ConnectorConfirmBrokerDeps): ConnectorConfirmBroker {
  const now = deps.now ?? (() => Date.now())
  const ttl = deps.ttlMs ?? COMMAND_PROPOSAL_TTL_ASSISTIVE_MS
  const guardMs = deps.minDecideDelayMs ?? COMMAND_RETURN_GUARD_MS
  const schedule = deps.schedule ?? scheduleConfirmDeadline
  const byId = new Map<string, Pending>()
  const byOwner = new Map<number, string>()
  const settled = new Set<string>()
  const audit = (event: string, metadata: Record<string, string | number | boolean>): void => {
    try {
      deps.audit?.(event, metadata)
    } catch {
      /* audit is best effort */
    }
  }
  const push = (webContentsId: number, state: ConnectorConfirmState): void => {
    try {
      deps.send(webContentsId, state)
    } catch {
      /* the window may be gone; the card stays refusable by main */
    }
  }
  const close = (pending: Pending, outcome: ConfirmOutcome, label: string): void => {
    const id = pending.card.proposalId
    if (!byId.delete(id)) return
    pending.stopTimer()
    settled.add(id)
    if (settled.size > SETTLED_MEMORY) settled.delete(settled.values().next().value as string)
    const owner = pending.request.ownerWebContentsId
    if (byOwner.get(owner) === id) {
      byOwner.delete(owner)
      push(owner, { proposalId: null })
    }
    audit('connector.confirm.closed', {
      opId: pending.request.opId,
      effectClass: pending.request.effectClass,
      outcome: label
    })
    pending.settle(outcome)
  }

  return {
    issue(request) {
      const previousId = byOwner.get(request.ownerWebContentsId)
      const previous = previousId ? byId.get(previousId) : undefined
      if (previous) close(previous, { confirmed: false, reason: 'cancelled' }, 'replaced')
      const proposalId = randomBytes(16).toString('hex')
      const nonce = randomBytes(32).toString('hex')
      const shownAt = now()
      const card: ConnectorConfirmCard = {
        proposalId,
        nonce,
        argsHash: request.argsHash,
        summary: request.summary,
        connectorLabel: request.connectorLabel,
        ...(request.accountLabel ? { accountLabel: request.accountLabel } : {}),
        ...(request.maskedHint ? { maskedHint: request.maskedHint } : {}),
        effectClass: request.effectClass,
        ...(request.subjectPreview ? { subjectPreview: request.subjectPreview.slice(0, 80) } : {}),
        ...(request.recipients?.length
          ? { recipients: request.recipients.map((r) => ({ address: r.address, source: r.source })) }
          : {}),
        expiresAt: shownAt + ttl
      }
      return new Promise<ConfirmOutcome>((resolve) => {
        const pending: Pending = {
          card,
          request,
          shownAt,
          settle: resolve,
          stopTimer: schedule(() => {
            const live = byId.get(proposalId)
            if (live) close(live, { confirmed: false, reason: 'expired' }, 'expired')
          }, ttl)
        }
        byId.set(proposalId, pending)
        byOwner.set(request.ownerWebContentsId, proposalId)
        push(request.ownerWebContentsId, card)
        audit('connector.confirm.issued', { opId: request.opId, effectClass: request.effectClass })
      })
    },

    current(webContentsId) {
      const id = byOwner.get(webContentsId)
      const pending = id ? byId.get(id) : undefined
      if (!pending) return { proposalId: null }
      if (now() >= pending.card.expiresAt) {
        close(pending, { confirmed: false, reason: 'expired' }, 'expired')
        return { proposalId: null }
      }
      return pending.card
    },

    decide(input) {
      const pending = byId.get(input.proposalId)
      if (!pending) return { ok: false, reason: settled.has(input.proposalId) ? 'already_decided' : 'missing' }
      if (pending.request.ownerWebContentsId !== input.webContentsId) return { ok: false, reason: 'owner_mismatch' }
      if (!secureEqual(pending.card.nonce, input.nonce)) return { ok: false, reason: 'nonce_mismatch' }
      if (!secureEqual(pending.card.argsHash, input.argsHash)) return { ok: false, reason: 'args_mismatch' }
      if (now() >= pending.card.expiresAt) {
        close(pending, { confirmed: false, reason: 'expired' }, 'expired')
        return { ok: false, reason: 'expired' }
      }
      if (!input.confirm) {
        close(pending, { confirmed: false, reason: 'cancelled' }, 'declined')
        return { ok: true }
      }
      if (now() - pending.shownAt < guardMs) return { ok: false, reason: 'too_soon' }
      if (deps.catalogRevision() !== pending.request.revision) {
        close(pending, { confirmed: false, reason: 'stale' }, 'stale')
        return { ok: false, reason: 'stale' }
      }
      // Consume before the operation runs, so a double click or a replay cannot approve it twice.
      close(
        pending,
        {
          confirmed: true,
          approval: { proposalId: pending.card.proposalId, argsHash: pending.request.argsHash }
        },
        'confirmed'
      )
      return { ok: true }
    },

    cancel(input) {
      const pending = byId.get(input.proposalId)
      if (!pending || pending.request.ownerWebContentsId !== input.webContentsId) return false
      if (!secureEqual(pending.card.nonce, input.nonce)) return false
      close(pending, { confirmed: false, reason: 'cancelled' }, 'cancelled')
      return true
    },

    revokeAll(reason) {
      for (const pending of [...byId.values()]) close(pending, { confirmed: false, reason: 'revoked' }, reason)
    }
  }
}
