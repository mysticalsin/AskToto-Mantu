export type CommandProposalPreview = {
  proposalId: string
  nonce: string
  /** Hash of the exact request main will run. Echoed back on confirmation so the approval is bound to it. */
  argsHash: string
  expiresAt: number
  /** Main must generate this exact, allowlisted consequence. Raw transcript is never a preview. */
  preview: string
}

export type CommandProposalCardProps = {
  proposal: CommandProposalPreview
  onConfirm: (confirmation: { proposalId: string; nonce: string; argsHash: string }) => void
  onCancel: (cancellation: { proposalId: string; nonce: string }) => void
}

/**
 * Renders only when a future main-owned command state supplies an exact allowlisted preview.
 * It deliberately cannot turn an opaque proposal ID into a misleading or model-authored consequence.
 */
export function CommandProposalCard({ proposal, onConfirm, onCancel }: CommandProposalCardProps): JSX.Element | null {
  const cancellation = { proposalId: proposal.proposalId, nonce: proposal.nonce }
  const confirmation = { ...cancellation, argsHash: proposal.argsHash }
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
        onCancel(cancellation)
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
          onClick={() => onCancel(cancellation)}
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
