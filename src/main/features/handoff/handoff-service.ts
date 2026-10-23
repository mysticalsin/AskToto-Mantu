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
import type { NonceLedger } from './nonce-ledger'

export type HandoffAuditEvent = 'handoff.accepted' | 'handoff.rejected'
export type HandoffAuditDetail = { reason: HandoffRejectReason } | { origin: HandoffOrigin; kind: 'note' }

export type HandoffReceipt = { ok: true; record: ContextRecord } | { ok: false; reason: HandoffRejectReason }

export interface HandoffServiceDeps {
  now: () => number
  ledger: NonceLedger
  /** Show the confirmation card for this request. Resolves false when no card could be shown. */
  propose(request: DesktopActionRequest): Promise<boolean>
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
      await deps.ledger.hydrate()
      const verdict = deps.ledger.consume(parsed.envelope.nonce, parsed.envelope.expiresAt)
      if (verdict === 'replayed') return refuse('replayed')
      if (verdict === 'full') return refuse('ledger_full')
      let shown = false
      try {
        shown = await deps.propose(parsed.request)
      } catch {
        shown = false
      }
      if (!shown) return refuse('not_shown')
      deps.audit('handoff.accepted', { origin: parsed.envelope.origin, kind: parsed.envelope.payload.kind })
      const { title, body } = parsed.envelope.payload.data
      return { ok: true, record: contextRecord('connector', body ? `${title}\n${body}` : title) }
    }
  }
}
