import { useEffect, useState } from 'react'
import type { MeetingSummary } from '@shared/ipc'
import { applyHydration, rowStatus, type Hydrations, type RowHydration } from './hydration'

const TONE_CLASS = {
  muted: 'bg-white/[0.06] text-[color:var(--color-ink-3)]',
  accent: 'bg-[var(--color-accent-soft)] text-[color:var(--color-accent-text)]',
  danger: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)]'
} as const

/** The explicit-open downloads main reports, by meeting basename. `onDone` runs after each finished
 *  download so History re-lists and the row turns into the real meeting; keep it stable. */
export function useRecallHydration(onDone: () => void): Hydrations {
  const [hydrations, setHydrations] = useState<Hydrations>({})
  useEffect(
    () =>
      window.toto.onRecallHydration((event) => {
        setHydrations((current) => applyHydration(current, event))
        if (event.state === 'done') onDone()
      }),
    [onDone]
  )
  return hydrations
}

/** A History row's status chip: Downloading… / Download failed / Not downloaded / Locked, or nothing. */
export function RowStatusChip({
  meeting,
  hydration
}: {
  meeting: Pick<MeetingSummary, 'locked' | 'notDownloaded'>
  hydration: RowHydration | undefined
}): JSX.Element | null {
  const status = rowStatus(meeting, hydration)
  if (!status) return null
  return (
    <span
      title={status.title}
      role={status.live ? 'status' : undefined}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${TONE_CLASS[status.tone]}`}
    >
      {status.label}
    </span>
  )
}
