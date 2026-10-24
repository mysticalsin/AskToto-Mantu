import { useCallback, useEffect, useState } from 'react'
import type { AccountChoiceCard as AccountChoiceCardState, AccountChoiceOption } from '@shared/connector-account-choice'
import { AccountChoiceCard } from './AccountChoiceCard'

/** Honest sentences for a choice main refused. Nothing ran in any of these cases. */
const REFUSED_COPY: Readonly<Record<string, string>> = {
  expired: 'That took too long, so nothing was done. Try again.',
  stale: 'Métis changed while you were choosing, so nothing was done. Try again.',
  too_soon: ''
}
const DEFAULT_REFUSED_COPY = "Métis can't do this right now. Nothing was done."

/**
 * Hosts the account choice card (G62). Main owns the card, its nonce and the pending operation; this component only
 * shows what main published and echoes the card's ids with the account the person picked. `onNotice` carries the
 * outcome sentence to the command line the voice-action card already uses.
 */
export function AccountChoiceHost({ onNotice }: { onNotice: (text: string) => void }): JSX.Element | null {
  const [card, setCard] = useState<AccountChoiceCardState | null>(null)

  useEffect(() => {
    let live = true
    const apply = (state: { choiceId: string | null }): void => {
      if (live) setCard(state.choiceId === null ? null : (state as AccountChoiceCardState))
    }
    const off = window.toto.accountChoice.onChanged(apply)
    void window.toto.accountChoice
      .current()
      .then(apply)
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])

  const choose = useCallback(
    async (current: AccountChoiceCardState, option: AccountChoiceOption) => {
      try {
        const response = await window.toto.accountChoice.decide({
          choiceId: current.choiceId,
          nonce: current.nonce,
          argsHash: current.argsHash,
          accountRef: option.accountRef
        })
        if (response.ok) {
          onNotice(response.result.ok ? 'Done.' : (response.result.error ?? DEFAULT_REFUSED_COPY))
        } else if (response.reason !== 'too_soon') {
          onNotice(REFUSED_COPY[response.reason] ?? DEFAULT_REFUSED_COPY)
        }
      } catch {
        onNotice(DEFAULT_REFUSED_COPY)
      }
    },
    [onNotice]
  )
  const cancel = useCallback(async (current: AccountChoiceCardState) => {
    await window.toto.accountChoice.cancel({ choiceId: current.choiceId, nonce: current.nonce }).catch(() => undefined)
  }, [])

  if (!card) return null
  return (
    <AccountChoiceCard
      key={card.choiceId}
      card={card}
      onChoose={(option) => void choose(card, option)}
      onCancel={() => void cancel(card)}
    />
  )
}
