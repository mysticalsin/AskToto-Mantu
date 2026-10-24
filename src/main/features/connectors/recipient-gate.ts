import { recipientFieldsIn } from '@shared/recipient-resolution'
import type { AccountRef } from '@shared/connector-catalog'

export interface TrustedRecipient {
  address: string
  /** Closed label of where main learned the address (for example `calendar-attendee`). Never content. */
  source: string
}

/**
 * Where trusted recipient addresses come from (G64). Only main-owned state may answer: a calendar invite the owner
 * received, an owner contact, a thread participant. A renderer- or model-supplied address never verifies itself.
 */
export interface TrustedRecipientSource {
  /** `accountRef` is absent for connections that are not account-registry accounts (MCP). */
  addressesFor(context: {
    accountRef?: AccountRef
    sourceAccountRef?: AccountRef
  }): Promise<readonly TrustedRecipient[]>
}

/** The production source until an attendee source (G21/G78) exists: nobody is trusted, so a write naming anyone fails closed. */
export const noTrustedRecipients: TrustedRecipientSource = {
  addressesFor: async () => []
}

export type RecipientVerification =
  | { ok: true; recipients: readonly TrustedRecipient[] }
  | { ok: false; recipientCount: number }

const norm = (address: string): string => address.trim().toLowerCase()

/** Every address under a recipient-bearing key must be in the trusted set. No recipient fields verifies vacuously. */
export function verifyRecipients(args: unknown, trusted: readonly TrustedRecipient[]): RecipientVerification {
  const fields = recipientFieldsIn(args)
  const byAddress = new Map(trusted.map((t) => [norm(t.address), t]))
  const matched: TrustedRecipient[] = []
  for (const field of fields) {
    const hit = byAddress.get(norm(field))
    if (!hit) return { ok: false, recipientCount: fields.length }
    if (!matched.includes(hit)) matched.push(hit)
  }
  return { ok: true, recipients: matched }
}
