import { describe, expect, it, vi } from 'vitest'
import { CommandProposalCard } from './CommandProposalCard'

type ElementNode = {
  type?: unknown
  props?: { children?: unknown; onClick?: () => void; 'aria-label'?: string }
}

function findByAriaLabel(node: unknown, label: string): ElementNode | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByAriaLabel(child, label)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as ElementNode
  if (element.props?.['aria-label'] === label) return element
  return findByAriaLabel(element.props?.children, label)
}

describe('CommandProposalCard', () => {
  it('forwards only the opaque proposal pair when confirmation is chosen', () => {
    const confirm = vi.fn()
    const proposal = {
      proposalId: 'a'.repeat(32),
      nonce: 'b'.repeat(64),
      preview: 'Open Notes',
      expiresAt: Date.now() + 10_000
    }

    const tree = CommandProposalCard({ proposal, onConfirm: confirm, onCancel: vi.fn() })
    const button = findByAriaLabel(tree, 'Confirm action')
    button?.props?.onClick?.()

    expect(confirm).toHaveBeenCalledWith({ proposalId: proposal.proposalId, nonce: proposal.nonce })
  })

  it('forwards the same opaque pair when Escape cancels the reviewed action', () => {
    const cancel = vi.fn()
    const proposal = {
      proposalId: 'c'.repeat(32),
      nonce: 'd'.repeat(64),
      preview: 'Open Notes',
      expiresAt: Date.now() + 10_000
    }

    const tree = CommandProposalCard({ proposal, onConfirm: vi.fn(), onCancel: cancel })
    const card = findByAriaLabel(tree, 'Command proposal')
    card?.props?.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() } as unknown as never)

    expect(cancel).toHaveBeenCalledWith({ proposalId: proposal.proposalId, nonce: proposal.nonce })
  })
})
