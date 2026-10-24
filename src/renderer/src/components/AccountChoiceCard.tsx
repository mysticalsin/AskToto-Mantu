import { useEffect, useRef } from 'react'
import type { AccountChoiceCard as AccountChoiceCardState, AccountChoiceOption } from '@shared/connector-account-choice'
import type { ConnectorAccountHealth } from '@shared/connector-accounts'

/** What the row says about an account that cannot be picked or has not been verified yet. */
export function accountOptionNote(health: ConnectorAccountHealth, selectable: boolean): string | null {
  if (health === 'connecting') return 'Verified when you use it'
  if (selectable) return null
  if (health === 'needs_reauth') return 'Needs attention. Reconnect it in Settings.'
  if (health === 'degraded') return 'Having trouble connecting right now'
  return 'Not available'
}

/** The accessible name of an account button: what it is and which account, never the full address. */
export function accountOptionLabel(option: AccountChoiceOption): string {
  return option.maskedHint ? `Use ${option.label}, ${option.maskedHint}` : `Use ${option.label}`
}

const neutralButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/12 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.08]'
const rowButton =
  'no-drag focus-ring flex w-full flex-col items-start rounded-[10px] border border-white/12 bg-white/[0.04] px-3 py-2 text-left text-[12px] text-[color:var(--color-ink)] transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/[0.04]'

/**
 * The account choice card (G62): shown when more than one account could run an operation and none was chosen for
 * it. It lists renderer-safe account views and nothing about the operation's content. Focus starts on Cancel and
 * Escape cancels, so a held Return can never pick an account; main also refuses a choice inside the first 300 ms.
 * Opus owns the final visual design; this follows the confirmation sheet's chrome.
 */
export function AccountChoiceCard({
  card,
  onChoose,
  onCancel
}: {
  card: AccountChoiceCardState
  onChoose: (option: AccountChoiceOption) => void
  onCancel: () => void
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (invoker?.isConnected) invoker.focus()
    }
    // One registration per card: the host keys this component by choice id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const titleId = `account-choice-title-${card.choiceId}`
  const detailId = `account-choice-detail-${card.choiceId}`
  return (
    <div className="pointer-events-auto absolute inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 rounded-[20px] bg-black/45 backdrop-blur-sm" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        data-account-choice="1"
        className="glass-strong relative w-full max-w-[420px] rounded-2xl border border-white/15 p-4 shadow-2xl"
      >
        <h2 id={titleId} className="m-0 text-[14px] font-semibold text-[color:var(--color-ink)]">
          {card.title}
        </h2>
        <p id={detailId} className="m-0 mt-1 text-[12px] leading-snug text-[color:var(--color-ink-2)]">
          {card.detail}
        </p>
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          {card.options.map((option) => {
            const note = accountOptionNote(option.health, option.selectable)
            return (
              <li key={option.accountRef}>
                <button
                  type="button"
                  className={rowButton}
                  disabled={!option.selectable}
                  aria-label={accountOptionLabel(option)}
                  onClick={() => onChoose(option)}
                >
                  <span className="font-semibold">{option.label}</span>
                  {option.maskedHint ? (
                    <span className="text-[11px] text-[color:var(--color-ink-3)]">{option.maskedHint}</span>
                  ) : null}
                  {note ? <span className="text-[11px] text-[color:var(--color-ink-3)]">{note}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="mt-4 flex justify-end">
          <button ref={cancelRef} type="button" className={neutralButton} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  )
}
