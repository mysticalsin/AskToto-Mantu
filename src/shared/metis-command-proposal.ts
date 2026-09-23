import { desktopActionFingerprint, type DesktopActionRequest } from './desktop-actions'

/** A proposal is descriptive only; Task 5 will add main-owned confirmation authority. */
export type CommandProposal = {
  id: string
  sessionId: string
  utteranceRevision: number
  contextHash: string
  request: DesktopActionRequest
  fingerprint: string
  expiresAt: number
}

export const METIS_COMMAND_PROPOSAL_TTL_MS = 5_000

export function commandContextHash(text: string): string {
  let hash = 0x811c9dc5
  for (const char of text.normalize('NFKC')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export function createCommandProposal(input: {
  sessionId: string
  utteranceRevision: number
  contextHash: string
  request: DesktopActionRequest
  now?: number
  ttlMs?: number
}): CommandProposal {
  const now = input.now ?? Date.now()
  const fingerprint = desktopActionFingerprint(input.request)
  return {
    id: `${input.sessionId}:${input.utteranceRevision}:${fingerprint}`,
    sessionId: input.sessionId,
    utteranceRevision: input.utteranceRevision,
    contextHash: input.contextHash,
    request: input.request,
    fingerprint,
    expiresAt: now + (input.ttlMs ?? METIS_COMMAND_PROPOSAL_TTL_MS)
  }
}

export function isCommandProposalExpired(proposal: CommandProposal, now = Date.now()): boolean {
  return now >= proposal.expiresAt
}
