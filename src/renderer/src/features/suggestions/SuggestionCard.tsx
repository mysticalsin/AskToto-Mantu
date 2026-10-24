/**
 * One suggestion card (G69, CAP-32): the title, each piece of evidence with its event time and read time, and Accept,
 * Not useful and Edit. An expired or stale card says so and cannot be accepted.
 */
import type { CardView } from '@shared/suggestions'
import { evidenceLine } from './suggestion-copy'

type Anchored = (card: CardView, anchor: HTMLElement) => void

const btn =
  'no-drag cl-focus min-h-[28px] rounded-md px-2.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/10 disabled:opacity-40'

export function SuggestionCard({
  card,
  stale,
  now,
  compact,
  onAccept,
  onDismiss,
  onEdit
}: {
  card: CardView
  stale: boolean
  now: number
  /** Overlay: one evidence line, so the stack stays short. */
  compact: boolean
  onAccept: Anchored
  onDismiss: Anchored
  onEdit: Anchored
}): JSX.Element {
  const evidence = compact ? card.evidence.slice(0, 1) : card.evidence
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--cl-foreground)]">
          {card.title}
        </span>
        {stale && (
          <span className="shrink-0 rounded-full border border-[var(--cl-border)] px-1.5 text-[11px] text-[color:var(--cl-muted-foreground)]">
            Expired
          </span>
        )}
      </div>
      {evidence.length > 0 && (
        <ul aria-label="Evidence" className="list-none pl-0 text-[11px] text-[color:var(--cl-muted-foreground)]">
          {evidence.map((e, i) => (
            <li key={`${e.sourceKind}-${i}`} className="truncate">
              {evidenceLine(e, now)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={`${btn} text-[color:var(--cl-primary)]`}
          disabled={stale}
          onClick={(e) => onAccept(card, e.currentTarget)}
        >
          Accept
        </button>
        <button type="button" className={btn} aria-haspopup="dialog" onClick={(e) => onDismiss(card, e.currentTarget)}>
          Not useful
        </button>
        <button
          type="button"
          className={btn}
          aria-haspopup="dialog"
          disabled={stale}
          onClick={(e) => onEdit(card, e.currentTarget)}
        >
          Edit
        </button>
      </div>
    </div>
  )
}
