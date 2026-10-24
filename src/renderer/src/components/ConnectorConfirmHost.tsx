import { useCallback, useEffect, useState } from 'react'
import type { ConnectorConfirmCard as ConnectorConfirmCardState } from '@shared/connector-confirm'
import { ConnectorConfirmCard } from './ConnectorConfirmCard'

/** Honest sentences for a decision main refused. Nothing ran in any of these cases. */
const REFUSED_COPY: Readonly<Record<string, string>> = {
  expired: 'That took too long, so nothing was done. Try again.',
  stale: 'Métis changed while you were deciding, so nothing was done. Try again.',
  too_soon: ''
}
const DEFAULT_REFUSED_COPY = "Métis can't do this right now. Nothing was done."

/**
 * Hosts the connector confirm card (G64). Main owns the card, its nonce and the pending write; this component only
 * shows what main published and echoes the card's ids with a yes or a no. The write's own result reaches the
 * button that asked for it, so only refusals are announced here.
 */
export function ConnectorConfirmHost({ onNotice }: { onNotice: (text: string) => void }): JSX.Element | null {
  const [card, setCard] = useState<ConnectorConfirmCardState | null>(null)

  useEffect(() => {
    let live = true
    const apply = (state: { proposalId: string | null }): void => {
      if (live) setCard(state.proposalId === null ? null : (state as ConnectorConfirmCardState))
    }
    const off = window.toto.connectorConfirm.onChanged(apply)
    void window.toto.connectorConfirm
      .current()
      .then(apply)
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])

  const decide = useCallback(
    async (current: ConnectorConfirmCardState, confirm: boolean) => {
      try {
        const response = await window.toto.connectorConfirm.decide({
          proposalId: current.proposalId,
          nonce: current.nonce,
          argsHash: current.argsHash,
          confirm
        })
        if (!response.ok && response.reason !== 'too_soon') {
          onNotice(REFUSED_COPY[response.reason] ?? DEFAULT_REFUSED_COPY)
        }
      } catch {
        onNotice(DEFAULT_REFUSED_COPY)
      }
    },
    [onNotice]
  )

  if (!card) return null
  return (
    <ConnectorConfirmCard
      key={card.proposalId}
      card={card}
      onConfirm={() => void decide(card, true)}
      onCancel={() => void decide(card, false)}
    />
  )
}
