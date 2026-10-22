import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MetisCommandState } from '@shared/metis-command-contract'
import { CommandProposalCard, commandProposalRequest } from './CommandProposalCard'

type Proposal = Extract<MetisCommandState, { proposalId: string }>

const proposal: Proposal = {
  proposalId: 'a'.repeat(32),
  nonce: 'b'.repeat(64),
  argsHash: 'e'.repeat(64),
  expiresAt: 1_012_000,
  revision: 3,
  actionId: 'desktop.create_note',
  risk: 'create',
  appIconKey: 'notes',
  preview: { title: 'Create a note in Notes', argument: 'Groceries', confirmLabel: 'Create' }
}

describe('commandProposalRequest (what the card shows is exactly what main allowlisted)', () => {
  it('uses the main-built title, quotes the exact argument and names the action with a verb', () => {
    expect(commandProposalRequest(proposal)).toMatchObject({
      kind: 'confirm',
      title: 'Create a note in Notes',
      message: '“Groceries”',
      saveLabel: 'Create',
      cancelLabel: 'Cancel'
    })
  })

  it('shows a plain detail sentence when there is no quoted argument', () => {
    const windowsPhoto: Proposal = {
      ...proposal,
      actionId: 'desktop.photo_booth_capture',
      risk: 'reversible',
      preview: { title: 'Open Camera', detail: 'Press the shutter yourself.', confirmLabel: 'Open' }
    }
    expect(commandProposalRequest(windowsPhoto).message).toBe('Press the shutter yourself.')
  })

  it('shows the argument and then the detail (a note body) so nothing that will run is hidden', () => {
    const withBody: Proposal = { ...proposal, preview: { ...proposal.preview, detail: 'milk and eggs' } }
    expect(commandProposalRequest(withBody).message).toBe('“Groceries”\nmilk and eggs')
  })

  it('is never styled destructive: the person deliberately asked for the action', () => {
    expect(commandProposalRequest(proposal).destructive).toBeUndefined()
  })
})

describe('CommandProposalCard', () => {
  const html = renderToStaticMarkup(
    <CommandProposalCard proposal={proposal} onConfirm={() => {}} onCancel={() => {}} />
  )

  it('is an alert dialog labelled by the title and described by the argument', () => {
    expect(html).toContain('role="alertdialog"')
    expect(html).toMatch(/aria-labelledby="([^"]+)"/)
    expect(html).toMatch(/aria-describedby="([^"]+)"/)
    expect(html).toContain('Create a note in Notes')
    expect(html).toContain('“Groceries”')
  })

  it('offers Cancel and a verb button, never OK or Confirm', () => {
    expect(html).toContain('>Cancel<')
    expect(html).toContain('>Create<')
    expect(html).not.toContain('>OK<')
    expect(html).not.toContain('>Confirm<')
  })

  it('never renders the nonce or the args hash', () => {
    expect(html).not.toContain(proposal.nonce)
    expect(html).not.toContain(proposal.argsHash)
    expect(html).not.toContain(proposal.proposalId)
  })
})
