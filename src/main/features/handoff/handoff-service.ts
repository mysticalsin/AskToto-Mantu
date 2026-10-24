/**
 * Receives a handoff URL and, only if every check passes, asks for the owner's confirmation (G37).
 *
 * Order: URL shape and size, then the envelope (version, origin, window, digest, payload), then the single-use
 * nonce, then the confirmation card through CommandControl (G04 argsHash, V04 card, G32 task path). Nothing runs
 * here. The payload text is data (G36): it is returned tagged as a `connector` record, never as an instruction.
 */
import { contextRecord, type ContextRecord } from '@shared/context-authority'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { parseHandoffEnvelope, type HandoffOrigin, type HandoffRejectReason } from './handoff-envelope'
import { envelopeTextFromUrl } from './handoff-url'
import type { HandoffRateLimit } from './handoff-rate-limit'
import type { NonceLedger } from './nonce-ledger'

export type HandoffAuditEvent = 'handoff.accepted' | 'handoff.rejected'
export type HandoffAuditDetail = { reason: HandoffRejectReason } | { claimedOrigin: HandoffOrigin; kind: 'note' }

export type HandoffReceipt = { ok: true; record: ContextRecord } | { ok: false; reason: HandoffRejectReason }

export interface HandoffServiceDeps {
  now: () => number
  ledger: NonceLedger
  rateLimit: HandoffRateLimit
  /** A card or confirmed action is already pending: an outside request never replaces it. */
  isBusy(): boolean
  /**
   * Show the confirmation card for this request. Resolves false when no card could be shown, and 'busy' when a
   * card appeared while the request was being checked: the installation boundary refuses to replace it.
   */
  propose(request: DesktopActionRequest): Promise<boolean | 'busy'>
  audit(event: HandoffAuditEvent, detail: HandoffAuditDetail): void
}

export interface HandoffService {
  receive(url: string): Promise<HandoffReceipt>
}

export function createHandoffService(deps: HandoffServiceDeps): HandoffService {
  const refuse = (reason: HandoffRejectReason): HandoffReceipt => {
    deps.audit('handoff.rejected', { reason })
    return { ok: false, reason }
  }
  return {
    async receive(url) {
      const text = envelopeTextFromUrl(url)
      if (!text.ok) return refuse(text.reason)
      const parsed = parseHandoffEnvelope(text.text, deps.now())
      if (!parsed.ok) return refuse(parsed.reason)
      if (deps.isBusy()) return refuse('busy')
      if (!deps.rateLimit.take(deps.now())) return refuse('rate_limited')
      // The nonce is durable before any card is proposed; an unreadable or unwritable store refuses the handoff.
      const verdict = await deps.ledger.consume(parsed.envelope.nonce, parsed.envelope.expiresAt)
      if (verdict === 'replayed') return refuse('replayed')
      if (verdict === 'full') return refuse('ledger_full')
      if (verdict === 'unavailable') return refuse('storage_unavailable')
      let shown: boolean | 'busy' = false
      try {
        shown = await deps.propose(parsed.request)
      } catch {
        shown = false
      }
      if (shown === 'busy') return refuse('busy')
      if (!shown) return refuse('not_shown')
      deps.audit('handoff.accepted', { claimedOrigin: parsed.envelope.origin, kind: parsed.envelope.payload.kind })
      const { title, body } = parsed.envelope.payload.data
      return { ok: true, record: contextRecord('connector', body ? `${title}\n${body}` : title) }
    }
  }
}
