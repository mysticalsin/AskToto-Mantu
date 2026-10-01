import { useEffect, useState } from 'react'
import { Cloud, CloudDownload, CloudOff, FileText, Lock } from 'lucide-react'
import type { MeetingSummary } from '@shared/ipc'
import {
  applyHydration,
  rowStatus,
  NOT_DOWNLOADED_TEXT,
  UNAVAILABLE_TEXT,
  type Hydrations,
  type RowFlags,
  type RowHydration
} from './hydration'

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

/** A History row's status chip: Downloading… / Download failed / Not downloaded / Unavailable / Locked, or nothing. */
export function RowStatusChip({
  meeting,
  hydration
}: {
  meeting: RowFlags
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

/** A History row's leading icon. The cloud-only and unreadable rows name their state to assistive tech, so
 *  a screen reader hears it before the title; a plain meeting's icon is decoration. */
export function RowIcon({ meeting }: { meeting: RowFlags }): JSX.Element {
  const className = 'shrink-0 text-[color:var(--color-ink-3)]'
  if (meeting.notDownloaded) return <Cloud size={12} className={className} role="img" aria-label={NOT_DOWNLOADED_TEXT} />
  if (meeting.unavailable) return <CloudOff size={12} className={className} role="img" aria-label={UNAVAILABLE_TEXT} />
  if (meeting.locked) return <Lock size={12} className={className} role="img" aria-label="Encrypted, can't be opened on this device" />
  return <FileText size={12} className={className} />
}

/** The one way to open a cloud-only meeting on purpose: downloads that file alone, then opens it. Disabled
 *  while its download runs (the chip reports the progress); after a failure it offers the retry. */
export function RowDownloadButton({
  meeting,
  hydration,
  onOpen
}: {
  meeting: Pick<MeetingSummary, 'file' | 'title' | 'notDownloaded'>
  hydration: RowHydration | undefined
  onOpen: (file: string) => void
}): JSX.Element | null {
  if (!meeting.notDownloaded) return null
  const failed = hydration?.state === 'failed'
  const label = failed ? 'Retry' : 'Download'
  return (
    <button
      type="button"
      aria-label={`${failed ? 'Retry downloading' : 'Download and open'} ${meeting.title}`}
      title={failed ? 'Retry the download' : 'Download this meeting and open it'}
      disabled={hydration?.state === 'hydrating'}
      onClick={() => onOpen(meeting.file)}
      className="no-drag focus-ring flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-[color:var(--color-accent-text)] transition-colors hover:bg-white/[0.06] disabled:opacity-40"
    >
      <CloudDownload size={12} />
      {label}
    </button>
  )
}
