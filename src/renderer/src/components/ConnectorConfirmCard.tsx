import { useEffect, useRef, useState } from 'react'
import { COMMAND_RETURN_GUARD_MS } from '@shared/command-return-guard'
import type { ConnectorConfirmCard as ConnectorConfirmCardState } from '@shared/connector-confirm'
import type { ConnectorEffectClass } from '@shared/connector-effects'

/** Plain-language effect line. A send is never described as a draft, and an irreversible write says so. */
export function effectClassNote(effectClass: ConnectorEffectClass): string {
  switch (effectClass) {
    case 'read':
      return 'This only reads.'
    case 'reversible_write':
      return 'This can be undone.'
    case 'irreversible_write':
      return 'This cannot be undone.'
    case 'send':
      return 'This sends a message and cannot be taken back.'
  }
}

const neutralButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/12 bg-white/[0.03] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink-2)] hover:bg-white/[0.08]'
const confirmButton =
  'no-drag focus-ring flex items-center gap-1.5 rounded-[10px] border border-white/20 bg-white/[0.12] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-ink)] hover:bg-white/[0.2] disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The connector confirm card (G64): every connector write waits for it. It names the connector and account, the
 * effect class and the verified recipients, never the arguments. Focus starts on Cancel and Escape cancels, so a held
 * Return can never confirm; Confirm stays disabled for the 300 ms return guard and main enforces the same guard.
 * Opus owns the final visual design; this follows the account choice card's chrome.
 */
export function ConnectorConfirmCard({
  card,
  onConfirm,
  onCancel,
  guardMs = COMMAND_RETURN_GUARD_MS
}: {
  card: ConnectorConfirmCardState
  onConfirm: () => void
  onCancel: () => void
  guardMs?: number
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    const timer = window.setTimeout(() => setArmed(true), guardMs)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey, true)
      if (invoker?.isConnected) invoker.focus()
    }
    // One registration per card: the host keys this component by proposal id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const titleId = `connector-confirm-title-${card.proposalId}`
  const detailId = `connector-confirm-detail-${card.proposalId}`
  const where = card.accountLabel ? `${card.connectorLabel}, ${card.accountLabel}` : card.connectorLabel
  return (
    <div className="pointer-events-auto absolute inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 rounded-[20px] bg-black/45 backdrop-blur-sm" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={detailId}
        data-connector-confirm="1"
        data-effect-class={card.effectClass}
        className="glass-strong relative w-full max-w-[420px] rounded-2xl border border-white/15 p-4 shadow-2xl"
      >
        <h2 id={titleId} className="m-0 text-[14px] font-semibold text-[color:var(--color-ink)]">
          {card.summary}
        </h2>
        <p id={detailId} className="m-0 mt-1 text-[12px] leading-snug text-[color:var(--color-ink-2)]">
          {where}
          {card.maskedHint ? ` (${card.maskedHint})` : ''}. {effectClassNote(card.effectClass)}
        </p>
        {card.subjectPreview ? (
          <p className="m-0 mt-2 text-[12px] text-[color:var(--color-ink)]">{card.subjectPreview}</p>
        ) : null}
        {card.recipients?.length ? (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[11px] text-[color:var(--color-ink-3)]">
            {card.recipients.map((recipient) => (
              <li key={recipient.address}>{recipient.address}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className={neutralButton} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={confirmButton} disabled={!armed} onClick={onConfirm}>
            Confirm
          </button>
        </div>
      </section>
    </div>
  )
}
