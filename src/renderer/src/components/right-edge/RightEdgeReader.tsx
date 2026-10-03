/**
 * RightEdgeReader.tsx — the right-edge Reader (M2-0202, spec v3 §6): the document surface beside the island
 * for everything too long for it, the full answer (R30), the live transcript (R31) and the full views (R33:
 * History, Review, Agenda, Brain), plus approval and error Details.
 *
 * Invariants:
 * - The Reader is the only right-edge surface those views mount under (data-re-surface="reader", RE-L05).
 * - It has exactly one scroller, [data-re-reader-scroll]; a nested view's own scroll box grows into it
 *   (right-edge-reader.css).
 * - Main sets the Reader's bounds before the page renders it, and the Reader fades in over
 *   RE_READER_CROSSFADE_MS (none under reduced motion).
 * - Its scroll position survives a park: the next explicit reveal restores it from `scrollMemory`.
 * - The live transcript follows the newest line while the reader sits at its end; scrolled back, a new line
 *   offers "Jump to live" instead of moving the text under the reader.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { MetisCommandState, TranscriptLine } from '@shared/ipc'
import { transcriptDisplayName } from '@shared/speaker-names'
import { RE_READER_CROSSFADE_MS } from '@shared/right-edge-timing'
import type { RightEdgeStrings } from '../../lib/right-edge/strings'
import { ElapsedClock } from '../Bar'
import { usePendingCommandCancel } from '../RightEdgeSidecar'
import './right-edge-reader.css'

export const RIGHT_EDGE_READER_KINDS = ['answer', 'transcript', 'history', 'review', 'agenda', 'brain', 'details'] as const
export type RightEdgeReaderKind = (typeof RIGHT_EDGE_READER_KINDS)[number]

/** The full views that open only in the Reader on the right edge. Settings keeps its own surface. */
export function readerKindForView(view: string): RightEdgeReaderKind | null {
  return view === 'history' || view === 'review' || view === 'agenda' || view === 'brain' ? view : null
}

/** The Reader header's status: 'attention' while an action waits for the user. */
export type RightEdgeReaderTone = 'ready' | 'thinking' | 'listening' | 'paused' | 'attention'

/** A waiting action outranks work in progress, which outranks a live meeting. */
export function rightEdgeReaderTone(state: { attention: boolean; thinking: boolean; listening: boolean; paused: boolean }): RightEdgeReaderTone {
  if (state.attention) return 'attention'
  if (state.thinking) return 'thinking'
  if (state.listening) return state.paused ? 'paused' : 'listening'
  return 'ready'
}

/** The Details' error list: every current non-empty error. */
export function rightEdgeDetailErrors(...errors: ReadonlyArray<string | null | undefined>): string[] {
  return errors.filter((error): error is string => typeof error === 'string' && error.length > 0)
}

export interface RightEdgeReaderMeeting {
  startedAt: number
  paused: boolean
  pausedMs: number
  pausedAt: number | null
}

/** Where each kind was scrolled to when the Reader last closed, and whether it sat at its end. */
export type RightEdgeReaderScrollMemory = MutableRefObject<Partial<Record<RightEdgeReaderKind, { top: number; atEnd: boolean }>>>

/** Within this many px of the end the reader is "at live". */
const AT_END_PX = 24

const TITLE: Record<RightEdgeReaderKind, keyof RightEdgeStrings> = {
  answer: 'titleAnswer',
  transcript: 'titleTranscript',
  history: 'titleHistory',
  review: 'titleReview',
  agenda: 'titleAgenda',
  brain: 'titleBrain',
  details: 'titleDetails'
}

const STATUS: Record<Exclude<RightEdgeReaderTone, 'attention'>, keyof RightEdgeStrings> = {
  ready: 'statusReady',
  thinking: 'statusThinking',
  listening: 'statusListening',
  paused: 'statusPaused'
}

function atEnd(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX
}

export function RightEdgeReader({
  kind,
  strings,
  tone,
  onAttention,
  meeting = null,
  consentDot = false,
  onBack,
  onHide,
  liveCount = 0,
  scrollMemory,
  children
}: {
  kind: RightEdgeReaderKind
  strings: RightEdgeStrings
  tone: RightEdgeReaderTone
  /** The status control while an action waits: shows the Details. */
  onAttention?: () => void
  /** Set while a meeting is live: the header carries its timer. */
  meeting?: RightEdgeReaderMeeting | null
  /** The consent indicator beside the timer (requireConsentIndicator). */
  consentDot?: boolean
  onBack: () => void
  /** Absent when the surface cannot park right now. */
  onHide?: () => void
  /** The live transcript's line count: a new line follows or offers "Jump to live". */
  liveCount?: number
  scrollMemory?: RightEdgeReaderScrollMemory
  children?: ReactNode
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // A saved position the content was not yet tall enough for (a view still loading): re-applied as it grows.
  const pendingTopRef = useRef<number | null>(null)
  const followRef = useRef(true)
  const [behindLive, setBehindLive] = useState(false)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const saved = scrollMemory?.current[kind]
    followRef.current = kind === 'transcript' && (saved === undefined || saved.atEnd)
    setBehindLive(false)
    if (followRef.current) {
      el.scrollTop = el.scrollHeight
      pendingTopRef.current = null
      return
    }
    el.scrollTop = saved?.top ?? 0
    pendingTopRef.current = saved && Math.abs(el.scrollTop - saved.top) > 1 ? saved.top : null
  }, [kind, scrollMemory])

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followRef.current) {
        el.scrollTop = el.scrollHeight
        return
      }
      const pending = pendingTopRef.current
      if (pending === null) return
      el.scrollTop = pending
      if (Math.abs(el.scrollTop - pending) <= 1) pendingTopRef.current = null
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

  // Only a line that arrives while the Reader is open moves it or offers "Jump to live".
  const seenCountRef = useRef(liveCount)
  useLayoutEffect(() => {
    const arrived = liveCount > seenCountRef.current
    seenCountRef.current = liveCount
    if (kind !== 'transcript' || !arrived) return
    const el = scrollRef.current
    if (!el) return
    if (followRef.current) el.scrollTop = el.scrollHeight
    else setBehindLive(true)
  }, [kind, liveCount])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const end = atEnd(el)
    if (kind === 'transcript') {
      followRef.current = end
      if (end) setBehindLive(false)
    }
    if (scrollMemory) scrollMemory.current[kind] = { top: el.scrollTop, atEnd: end }
  }

  const jumpToLive = (): void => {
    const el = scrollRef.current
    if (!el) return
    followRef.current = true
    setBehindLive(false)
    el.scrollTop = el.scrollHeight
  }

  return (
    <section
      className="re-reader"
      data-re-surface="reader"
      data-re-reader-kind={kind}
      aria-label={strings.readerLabel}
      style={{ '--re-reader-fade-ms': `${RE_READER_CROSSFADE_MS}ms` } as CSSProperties}
    >
      <header className="re-reader__header">
        <button
          type="button"
          className="re-reader__button re-reader__back no-drag focus-ring"
          aria-label={strings.backToIslandName}
          data-re-reader-back
          onClick={onBack}
        >
          {strings.backToIsland}
        </button>
        <h1 className="re-reader__title">{strings[TITLE[kind]]}</h1>
        {meeting ? (
          <span className="re-reader__timer" data-re-reader-timer role="timer" aria-label={strings.meetingTimer}>
            {consentDot ? <span className="re-reader__consent" data-re-consent-dot role="img" aria-label={strings.consentDot} /> : null}
            <ElapsedClock startedAt={meeting.startedAt} paused={meeting.paused} pausedMs={meeting.pausedMs} pausedAt={meeting.pausedAt} />
          </span>
        ) : null}
        {tone === 'attention' && onAttention ? (
          <button
            type="button"
            className="re-reader__button re-reader__status no-drag focus-ring"
            data-re-status
            data-re-tone="attention"
            aria-label={strings.statusAttentionName}
            onClick={onAttention}
          >
            <span className="re-reader__status-dot" aria-hidden="true" />
            {strings.statusAttention}
          </button>
        ) : (
          <span className="re-reader__status" data-re-status data-re-tone={tone} role="status">
            <span className="re-reader__status-dot" aria-hidden="true" />
            {tone === 'attention' ? strings.statusAttention : strings[STATUS[tone]]}
          </span>
        )}
        {onHide ? (
          <button
            type="button"
            className="re-reader__button re-reader__hide no-drag focus-ring"
            aria-label={strings.hideName}
            data-re-reader-hide
            onClick={onHide}
          >
            {strings.hide}
            <ChevronRight size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </header>
      <div ref={scrollRef} className="re-reader__scroll scroll-thin" data-re-reader-scroll tabIndex={0} aria-label={strings[TITLE[kind]]} onScroll={onScroll}>
        <div ref={contentRef} className="re-reader__content">
          {children}
        </div>
      </div>
      {kind === 'transcript' && behindLive ? (
        <button type="button" className="re-reader__button re-reader__jump no-drag focus-ring" data-re-reader-jump onClick={jumpToLive}>
          {strings.jumpToLive}
        </button>
      ) : null}
    </section>
  )
}

/** R31: the live transcript, newest line last. */
export function RightEdgeReaderTranscript({
  lines,
  strings,
  youLabel
}: {
  lines: readonly TranscriptLine[]
  strings: RightEdgeStrings
  youLabel?: string | null
}): JSX.Element {
  if (lines.length === 0) return <p className="re-reader__empty">{strings.transcriptEmpty}</p>
  return (
    <ol className="re-reader__transcript" aria-live="polite">
      {lines.map((line, index) => (
        <li key={`${line.t}-${index}`} className="re-reader__line" data-speaker={line.speaker} data-provisional={line.provisional || undefined}>
          <span className="re-reader__speaker">{transcriptDisplayName(line, { youLabel })}</span>
          <span className="re-reader__text">{line.text}</span>
        </li>
      ))}
    </ol>
  )
}

/** Approval and error Details: the pending action (never approvable without a verified preview) and every
 *  current error, in full. */
export function RightEdgeReaderDetails({
  commandState,
  errors,
  strings
}: {
  commandState: MetisCommandState
  errors: readonly string[]
  strings: RightEdgeStrings
}): JSX.Element {
  const pending = usePendingCommandCancel(commandState)
  if (!commandState.proposalId && errors.length === 0) return <p className="re-reader__empty">{strings.detailsEmpty}</p>
  return (
    <div className="re-reader__details">
      {commandState.proposalId ? (
        <section className="re-reader__detail" data-re-detail="approval" aria-label={strings.detailsApproval}>
          <h2 className="re-reader__detail-title">{strings.detailsApproval}</h2>
          <p>{strings.detailsApprovalBody}</p>
          <button
            type="button"
            className="re-reader__button re-reader__detail-action no-drag focus-ring"
            disabled={pending.status === 'cancelling'}
            onClick={pending.cancel}
          >
            {pending.status === 'cancelling' ? strings.detailsCancelling : strings.detailsCancel}
          </button>
        </section>
      ) : null}
      {errors.map((error, index) => (
        <section key={`${index}-${error}`} className="re-reader__detail" data-re-detail="error" aria-label={strings.detailsError}>
          <h2 className="re-reader__detail-title">{strings.detailsError}</h2>
          <p>{error}</p>
        </section>
      ))}
    </div>
  )
}
