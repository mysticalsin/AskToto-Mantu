export type CommandProposalPreview = {
  proposalId: string
  nonce: string
  expiresAt: number
  /** Main must generate this exact, allowlisted consequence. Raw transcript is never a preview. */
  preview: string
}

export type CommandProposalCardProps = {
  proposal: CommandProposalPreview
  onConfirm: (confirmation: { proposalId: string; nonce: string }) => void
  onCancel: (confirmation: { proposalId: string; nonce: string }) => void
}

function confirmationFor(proposal: CommandProposalPreview): { proposalId: string; nonce: string } {
  return { proposalId: proposal.proposalId, nonce: proposal.nonce }
}

/**
 * Renders only when a future main-owned command state supplies an exact allowlisted preview.
 * It deliberately cannot turn an opaque proposal ID into a misleading or model-authored consequence.
 */
export function CommandProposalCard({ proposal, onConfirm, onCancel }: CommandProposalCardProps): JSX.Element | null {
  const confirmation = confirmationFor(proposal)
  const preview = proposal.preview.trim()

  if (!preview) return null

  return (
    <section
      aria-label="Command proposal"
      data-metis-command-proposal-card="1"
      className="right-edge-command-card"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onCancel(confirmation)
      }}
    >
      <p className="right-edge-command-card__eyebrow">Ready to confirm</p>
      <p className="right-edge-command-card__preview">{preview}</p>
      <p className="right-edge-command-card__hint">Review the action before Métis does anything outside the app.</p>
      <div className="right-edge-command-card__actions">
        <button
          type="button"
          aria-label="Cancel action"
          className="no-drag focus-ring right-edge-command-card__cancel"
          onClick={() => onCancel(confirmation)}
        >
          Cancel
        </button>
        <button
          type="button"
          aria-label="Confirm action"
          className="no-drag focus-ring right-edge-command-card__confirm"
          onClick={() => onConfirm(confirmation)}
        >
          Confirm
        </button>
      </div>
    </section>
  )
}
