import { describe, expect, it } from 'vitest'
import {
  commandContextHash,
  createCommandProposal,
  isCommandProposalExpired
} from './metis-command-proposal'

describe('command proposal', () => {
  it('binds one allowlisted request to its session, revision, context, and expiry', () => {
    const proposal = createCommandProposal({
      sessionId: 'command-7',
      utteranceRevision: 3,
      contextHash: commandContextHash('open notes'),
      request: { id: 'desktop.open_notes', args: {} },
      now: 100
    })
    expect(proposal).toMatchObject({
      sessionId: 'command-7',
      utteranceRevision: 3,
      request: { id: 'desktop.open_notes' },
      expiresAt: 5_100
    })
    expect(isCommandProposalExpired(proposal, 5_099)).toBe(false)
    expect(isCommandProposalExpired(proposal, 5_100)).toBe(true)
  })
})
