import { useState } from 'react'
import { createReturnGuard } from '@shared/command-return-guard'
import type { MetisCommandState } from '@shared/metis-command-contract'
import type { NavigationGuardChoice, NavigationGuardRequest } from '../lib/navigation-guard'
import { ConfirmSheet } from '../ui/ConfirmSheet'

type CommandProposal = Extract<MetisCommandState, { proposalId: string }>

export type CommandProposalCardProps = {
  proposal: CommandProposal
  onConfirm: (confirmation: { proposalId: string; nonce: string; argsHash: string }) => void
  onCancel: (cancellation: { proposalId: string; nonce: string }) => void
}

/**
 * What the card says, derived only from main's allowlisted preview: a title (verb plus target), the exact argument
 * quoted (or a fixed detail sentence), and a verb on the default button. The transcript never reaches it. The action
 * is never styled destructive: the person deliberately asked for it, so Return is the default.
 */
export function commandProposalRequest(proposal: CommandProposal, id = 1): NavigationGuardRequest {
  const { preview } = proposal
  return {
    id,
    kind: 'confirm',
    title: preview.title,
    message: preview.argument ? `“${preview.argument}”` : (preview.detail ?? ''),
    saveLabel: preview.confirmLabel,
    cancelLabel: 'Cancel'
  }
}

/**
 * The voice-action confirmation card: an accessible alert dialog built on ConfirmSheet. Return confirms and Escape
 * cancels, but a Return that was held when the card appeared, an auto-repeat, or one inside the first 300 ms is
 * ignored (D-10). Opus owns the final visual design and motion (V05); this is the working skeleton.
 */
export function CommandProposalCard({ proposal, onConfirm, onCancel }: CommandProposalCardProps): JSX.Element {
  // One guard per card. The host keys this component by proposal id, so a replaced card starts its own 300 ms window.
  const [returnGuard] = useState(() => createReturnGuard())
  const choose = (choice: NavigationGuardChoice): void => {
    if (choice === 'save')
      onConfirm({ proposalId: proposal.proposalId, nonce: proposal.nonce, argsHash: proposal.argsHash })
    else onCancel({ proposalId: proposal.proposalId, nonce: proposal.nonce })
  }
  return (
    <ConfirmSheet
      request={commandProposalRequest(proposal, 1)}
      returnGuard={returnGuard}
      onChoose={(choice) => choose(choice)}
    />
  )
}
