import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  AudioLines,
  Brain,
  ChevronRight,
  CornerDownLeft,
  FileSearch,
  Image,
  LoaderCircle,
  Pause,
  Play,
  ScrollText,
  Settings,
  Square,
  X
} from 'lucide-react'
import type { MetisCommandState } from '@shared/ipc'
import { RIGHT_EDGE_DRAWER_WIDTH, RIGHT_EDGE_TAB_WIDTH } from '@shared/right-edge-geometry'
import { RIGHT_EDGE_STRINGS, type RightEdgeStrings } from '../lib/right-edge/strings'
import { ElapsedClock } from './Bar'
import { MantuMark } from './MantuMark'

export interface SidecarChatProps {
  /** Controlled by App so the dock uses the existing conversation state and submission route. */
  value?: string
  onChange?: (value: string) => void
  onSubmit?: () => void
  onStop?: () => void
  /** Prevents a second request while the existing route is working. */
  busy?: boolean
  /** True only when the current busy request can actually be cancelled. */
  stoppable?: boolean
  /** Existing answer content, supplied by App rather than recreated in the dock. */
  body?: ReactNode
  inputRef?: Ref<HTMLInputElement>
  /** A keystroke or a pointerdown in the composer: the typing pin (lib/right-edge/pins.ts). */
  onComposerActivity?: () => void
  /** An IME composition started or ended in the composer: the ime pin. */
  onComposingChange?: (composing: boolean) => void
}

/**
 * The edge composer is deliberately controlled. It never owns conversation state, invokes IPC, or
 * creates a second answer path; App supplies the same input, submit, stop, and answer body as the Bar.
 */
export function SidecarChat({
  value = '',
  onChange,
  onSubmit,
  onStop,
  busy = false,
  stoppable = false,
  inputRef,
  onComposerActivity,
  onComposingChange
}: SidecarChatProps): JSX.Element {
  const available = typeof onChange === 'function' && typeof onSubmit === 'function'
  const submit = (): void => {
    if (!available || busy) return
    onSubmit()
  }

  return (
    <form
      aria-label="Ask Métis"
      className="right-edge-sidecar__chat"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <input
        ref={inputRef}
        aria-label="Ask Métis anything"
        className="right-edge-sidecar__chat-input no-drag"
        disabled={!available || busy}
        onChange={(event) => onChange?.(event.target.value)}
        onPointerDown={onComposerActivity}
        onCompositionStart={() => onComposingChange?.(true)}
        onCompositionEnd={() => onComposingChange?.(false)}
        onKeyDown={(event) => {
          onComposerActivity?.()
          // D10: IME uses Enter to commit a composition (isComposing, or keyCode 229 on the keydown it consumes).
          // Sending then would discard the user's in-progress text.
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Ask Métis anything"
        spellCheck={false}
        value={value}
      />
      <button
        type={busy && stoppable ? 'button' : 'submit'}
        aria-label={busy && stoppable ? 'Stop answer' : 'Ask Métis'}
        className="right-edge-sidecar__chat-submit no-drag focus-ring"
        disabled={!available || (busy && !stoppable)}
        onClick={busy && stoppable ? onStop : undefined}
      >
        {busy ? (
          stoppable ? (
            <X size={16} strokeWidth={1.9} />
          ) : (
            <LoaderCircle size={16} strokeWidth={1.9} className="right-edge-sidecar__spin" />
          )
        ) : (
          <CornerDownLeft size={16} strokeWidth={1.9} />
        )}
      </button>
    </form>
  )
}

function DockAction({
  label,
  status,
  onClick,
  disabled,
  active,
  children
}: {
  label: string
  status?: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      className={[
        'right-edge-sidecar__action',
        'right-edge-sidecar__action--icon',
        'no-drag',
        'focus-ring',
        active ? 'right-edge-sidecar__action--active' : ''
      ].join(' ')}
      data-action-status={active ? 'active' : status ? 'busy' : 'idle'}
      disabled={disabled}
      onClick={onClick}
      title={status ? `${label}: ${status}` : label}
    >
      <span className="right-edge-sidecar__action-icon" aria-hidden="true">
        {children}
      </span>
      <span className="right-edge-sidecar__action-assist">{status ? `${label}: ${status}` : label}</span>
    </button>
  )
}

function compactLiveNotice(notice: string): string {
  const message = notice.trim()
  if (/^mic silent\b/i.test(message)) return 'Mic silent · check input'
  if (/^microphone input stopped\b/i.test(message)) return 'Mic lost · reconnecting'
  if (/^could(?: not|n['’]t) start the microphone\b/i.test(message)) return 'Mic unavailable · check access'
  if (/^microphone unavailable\. listening to system audio only\./i.test(message))
    return 'Mic unavailable · system audio only'
  if (/built-in transcription files/i.test(notice)) return 'Transcription repair'
  return notice
}

export type PendingCancelStatus = 'idle' | 'cancelling' | 'cancelled' | 'unavailable'

/** Cancels the opaque pending command (it has no verified preview, so it is never approvable); the status
 *  belongs to the proposal it was asked for and reads 'idle' for any other. */
export function usePendingCommandCancel(commandState: MetisCommandState): {
  status: PendingCancelStatus
  cancel: () => void
} {
  const [pendingCancel, setPendingCancel] = useState<{ proposalId: string | null; status: PendingCancelStatus }>({
    proposalId: null,
    status: 'idle'
  })
  const cancel = (): void => {
    if (!commandState.proposalId) return
    const proposalId = commandState.proposalId
    setPendingCancel({ proposalId, status: 'cancelling' })
    void window.toto
      .cancelMetisCommand({ proposalId, nonce: commandState.nonce })
      .then((result) => setPendingCancel({ proposalId, status: result.ok ? 'cancelled' : 'unavailable' }))
      .catch(() => setPendingCancel({ proposalId, status: 'unavailable' }))
  }
  const status =
    commandState.proposalId !== null && pendingCancel.proposalId === commandState.proposalId
      ? pendingCancel.status
      : 'idle'
  return { status, cancel }
}

/** What the dock's ↗ controls open in the Reader. */
export type SidecarReaderTarget = 'answer' | 'transcript' | 'details'

const ANSWER_PREVIEW_MAX = 140

/** The first readable line of a markdown answer as plain text, at most ANSWER_PREVIEW_MAX characters. Code
 *  blocks and table rows are never a preview line. */
export function rightEdgeAnswerPreview(markdown: string): string {
  let inFence = false
  for (const raw of markdown.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('```')) inFence = !inFence
    if (inFence || !trimmed || trimmed.startsWith('```') || trimmed.startsWith('|')) continue
    const line = trimmed
      .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\[([^\]]*)\]\([^)]*\)|[*`~]|(?<!\w)_+|_+(?!\w)/g, (_match, label: string | undefined) => label ?? '')
      .trim()
    if (!line) continue
    return line.length > ANSWER_PREVIEW_MAX ? `${line.slice(0, ANSWER_PREVIEW_MAX - 1).trimEnd()}…` : line
  }
  return ''
}

/** The dock's body for an answer on the right edge: a one-line summary. The full answer mounts only in the
 *  Reader (spec v3 §6, RE-L05); the header's Open ↗ opens it there. */
export function RightEdgeAnswerSummary({
  text,
  streaming,
  error,
  strings
}: {
  text: string
  streaming: boolean
  error?: string | null
  strings: RightEdgeStrings
}): JSX.Element {
  const preview = rightEdgeAnswerPreview(error || text)
  return (
    <p className="right-edge-sidecar__summary" data-re-answer-summary>
      {preview || (streaming ? strings.answerPending : strings.answerReady)}
    </p>
  )
}

/** Escape hides the dock whenever it can park, except while an IME composition owns the key (Escape
 *  cancels the composition there and must never hide the dock). */
export function dockEscapeHides(event: { key: string; isComposing: boolean }, canClose: boolean): boolean {
  return event.key === 'Escape' && !event.isComposing && canClose
}

export interface RightEdgeDockActions {
  listening?: boolean
  paused?: boolean
  startedAt?: number
  pausedMs?: number
  pausedAt?: number | null
  onToggleListen?: () => void
  onTogglePause?: () => void
  onTranscript?: () => void
  transcriptShown?: boolean
  capturing?: boolean
  onCapture?: () => void
  /** Opens the existing standalone Intelligence dashboard and reports an honest failure to the dock. */
  onOpenIntelligence?: () => Promise<{ ok: boolean; error?: string }>
  /** Uses the existing Dust-backed Spotlight Ref flow owned by App. */
  onSpotlightRef?: () => void
  /** Makes the existing unavailable path discoverable without implying Dust is connected. */
  spotlightReady?: boolean
  /** Opens the existing history surface owned by App. */
  onHistory?: () => void
  /** A live meeting notice that remains inside the dock instead of leaking from the parked rail. */
  liveNotice?: string | null
  onSettings?: () => void
  /** Opens long content in the Reader (spec v3 §6): the full answer, the live transcript or the Details. */
  onOpenReader?: (target: SidecarReaderTarget) => void
  /** There are approval or error Details to read. */
  detailsAvailable?: boolean
  /** The ↗ controls' copy (lib/right-edge/strings.ts). */
  readerStrings?: RightEdgeStrings
}

export function RightEdgeSidecar({
  open,
  onOpen,
  onClose,
  canClose = true,
  focusSignal = 0,
  commandState = { proposalId: null },
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  stoppable,
  body,
  listening = false,
  paused = false,
  startedAt,
  pausedMs = 0,
  pausedAt = null,
  onToggleListen,
  onTogglePause,
  onTranscript,
  transcriptShown = false,
  capturing = false,
  onCapture,
  onOpenIntelligence,
  onSpotlightRef,
  spotlightReady = false,
  onHistory,
  liveNotice,
  onSettings,
  onOpenReader,
  detailsAvailable = false,
  readerStrings = RIGHT_EDGE_STRINGS.en,
  onComposerActivity,
  onComposingChange
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The dock only offers dismissal when the current overlay state can actually park. */
  canClose?: boolean
  /** Bumped by a summon (hotkey, toggle, tray) so an already-open drawer hands the caret back to the composer. */
  focusSignal?: number
  /** Opaque state only. Main has not supplied a verified action preview in this version. */
  commandState?: MetisCommandState
} & SidecarChatProps &
  RightEdgeDockActions): JSX.Element {
  const pendingCancel = usePendingCommandCancel(commandState)
  const [intelligence, setIntelligence] = useState<{ status: 'idle' | 'opening' | 'error'; error?: string }>({
    status: 'idle'
  })
  const composerRef = useRef<HTMLInputElement>(null)
  // D4: an explicit open (a summon bumps focusSignal; a click on the rail tab) focuses the composer in the
  // commit that opens the drawer, never a frame later. A hover reveal opens it without moving focus.
  const focusedSignalRef = useRef(focusSignal)
  const tabOpenRef = useRef(false)
  useLayoutEffect(() => {
    if (!open || (focusedSignalRef.current === focusSignal && !tabOpenRef.current)) return
    focusedSignalRef.current = focusSignal
    tabOpenRef.current = false
    composerRef.current?.focus()
  }, [open, focusSignal])

  const cancelPendingCommand = pendingCancel.cancel

  const close = (): void => {
    // A proposal with no verified preview must never survive an edge-panel dismissal.
    cancelPendingCommand()
    onClose()
  }

  const openIntelligence = (): void => {
    if (!onOpenIntelligence || capturing || intelligence.status === 'opening') return
    setIntelligence({ status: 'opening' })
    void onOpenIntelligence()
      .then((result) => setIntelligence(result.ok ? { status: 'idle' } : { status: 'error', error: result.error }))
      .catch(() => setIntelligence({ status: 'error', error: 'Could not open Mantu Intelligence.' }))
  }

  const pendingCancelStatus = pendingCancel.status
  const hasBody = body !== undefined && body !== null
  const status = capturing
    ? 'Capturing screen'
    : listening
      ? paused
        ? 'Paused'
        : 'Listening'
      : busy
        ? 'Thinking'
        : 'Ready'

  return (
    <div
      className={'right-edge-sidecar' + (open ? ' right-edge-sidecar--open' : '')}
      data-re-surface={open ? 'island' : 'rest'}
    >
      <button
        type="button"
        aria-label="Open Métis"
        aria-expanded={open}
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : 0}
        onClick={() => {
          tabOpenRef.current = true
          onOpen()
        }}
        className="right-edge-sidecar__tab no-drag focus-ring"
        style={{ width: RIGHT_EDGE_TAB_WIDTH }}
      >
        <span className="right-edge-sidecar__rail" aria-hidden="true" />
      </button>
      {/* The drawer stays mounted while parked (hidden and out of the accessibility tree), so a reveal never
          re-mounts the answer and replays its entrance animation. */}
      <aside
        role="complementary"
        aria-label="Métis"
        aria-hidden={!open || undefined}
        className="right-edge-sidecar__drawer"
        style={{ maxWidth: RIGHT_EDGE_DRAWER_WIDTH }}
        onKeyDown={(event) => {
          // D11: Escape during an IME composition cancels the composition; the IME keeps it.
          const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
          if (dockEscapeHides({ key: event.key, isComposing }, canClose)) {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
      >
        <div className="right-edge-sidecar__drawer-scroll">
          <header className="right-edge-sidecar__header">
            <span className="right-edge-sidecar__header-leading">
              {canClose ? (
                <button
                  type="button"
                  aria-label="Hide Métis"
                  title="Hide"
                  onClick={close}
                  className="right-edge-sidecar__header-back no-drag focus-ring"
                >
                  <ChevronRight size={18} strokeWidth={1.9} aria-hidden="true" />
                </button>
              ) : null}
              <span className="right-edge-sidecar__identity">
                <span>Métis</span>
              </span>
            </span>
            <span className="right-edge-sidecar__header-leading">
              <span className="right-edge-sidecar__status" data-right-edge-status={status} aria-live="polite">
                <span className="right-edge-sidecar__status-dot" aria-hidden="true" />
                <span>{status}</span>
              </span>
              {onOpenReader && hasBody ? (
                <button
                  type="button"
                  aria-label={readerStrings.openReaderName}
                  className="right-edge-sidecar__history no-drag focus-ring"
                  data-re-open-reader="answer"
                  onClick={() => onOpenReader('answer')}
                >
                  {readerStrings.openReader}
                </button>
              ) : null}
            </span>
          </header>

          {liveNotice ? (
            <p className="right-edge-sidecar__status-notice" role="status" aria-label={liveNotice} title={liveNotice}>
              {compactLiveNotice(liveNotice)}
            </p>
          ) : null}

          {listening && onToggleListen ? (
            <div className="right-edge-sidecar__meeting" role="group" aria-label="Meeting controls">
              <span className="right-edge-sidecar__meeting-label">{paused ? 'Meeting paused' : 'Meeting live'}</span>
              {typeof startedAt === 'number' && startedAt > 0 ? (
                <span className="right-edge-sidecar__meeting-time" aria-label="Meeting duration">
                  <ElapsedClock startedAt={startedAt} paused={paused} pausedMs={pausedMs} pausedAt={pausedAt} />
                </span>
              ) : null}
              {onOpenReader ? (
                <DockAction label={readerStrings.openTranscriptName} onClick={() => onOpenReader('transcript')}>
                  <ScrollText size={16} strokeWidth={1.9} />
                </DockAction>
              ) : null}
              {onTogglePause ? (
                <DockAction label={paused ? 'Resume meeting' : 'Pause meeting'} onClick={onTogglePause}>
                  {paused ? <Play size={16} strokeWidth={1.9} /> : <Pause size={16} strokeWidth={1.9} />}
                </DockAction>
              ) : null}
              <DockAction label="Stop meeting" onClick={onToggleListen} active>
                <Square size={16} strokeWidth={1.9} />
              </DockAction>
            </div>
          ) : null}

          <section
            aria-label={body !== undefined && body !== null ? 'Métis response' : 'Métis ready'}
            aria-live="polite"
            className="right-edge-sidecar__body"
            tabIndex={body !== undefined && body !== null ? 0 : undefined}
          >
            {body !== undefined && body !== null ? (
              <div className="right-edge-sidecar__answer">{body}</div>
            ) : (
              <div className="right-edge-sidecar__empty">
                <span className="right-edge-sidecar__empty-mark">
                  <MantuMark size={22} round />
                </span>
                <p>Ready when you are</p>
                <span>Ask Métis, capture your screen, or start a meeting.</span>
              </div>
            )}
          </section>

          <div className="right-edge-sidecar__actions" aria-label="Métis actions">
            <div className="right-edge-sidecar__action-rail" data-right-edge-action-rail="true">
              {onCapture ? (
                <DockAction
                  label="Capture screen"
                  status={capturing ? 'Capturing' : undefined}
                  onClick={onCapture}
                  disabled={capturing}
                  active={capturing}
                >
                  {capturing ? (
                    <LoaderCircle size={17} strokeWidth={1.9} className="right-edge-sidecar__spin" />
                  ) : (
                    <Image size={17} strokeWidth={1.9} />
                  )}
                </DockAction>
              ) : null}
              {onSpotlightRef ? (
                <DockAction
                  label="Spotlight Ref"
                  status={spotlightReady ? undefined : 'Connect Dust'}
                  onClick={onSpotlightRef}
                >
                  <FileSearch size={17} strokeWidth={1.9} />
                </DockAction>
              ) : null}
              {onSettings ? (
                <DockAction label="Open settings" onClick={onSettings}>
                  <Settings size={17} strokeWidth={1.9} />
                </DockAction>
              ) : null}
              {onOpenIntelligence ? (
                <DockAction
                  label="Mantu Intelligence"
                  status={capturing ? 'Capturing' : intelligence.status === 'opening' ? 'Opening' : undefined}
                  onClick={openIntelligence}
                  disabled={intelligence.status === 'opening' || capturing}
                >
                  {intelligence.status === 'opening' ? (
                    <LoaderCircle size={17} strokeWidth={1.9} className="right-edge-sidecar__spin" />
                  ) : (
                    <Brain size={17} strokeWidth={1.9} />
                  )}
                </DockAction>
              ) : null}
              {!listening && onToggleListen ? (
                <span className="right-edge-sidecar__action-divider" aria-hidden="true" />
              ) : null}
              {!listening && onToggleListen ? (
                <DockAction label="Start listening" onClick={onToggleListen}>
                  <AudioLines size={17} strokeWidth={1.9} />
                </DockAction>
              ) : null}
              {listening && onTranscript ? (
                <button
                  type="button"
                  aria-label={transcriptShown ? 'Hide transcript' : 'Show transcript'}
                  aria-pressed={transcriptShown}
                  className="right-edge-sidecar__history no-drag focus-ring"
                  onClick={onTranscript}
                >
                  Transcript
                </button>
              ) : onHistory ? (
                <button
                  type="button"
                  aria-label="Open History"
                  className="right-edge-sidecar__history no-drag focus-ring"
                  onClick={onHistory}
                  title="History"
                >
                  History
                </button>
              ) : null}
            </div>
          </div>

          {intelligence.status === 'error' ? (
            <p className="right-edge-sidecar__notice" role="status">
              {intelligence.error}
            </p>
          ) : null}
          {commandState.proposalId ? (
            <section
              className="right-edge-sidecar__pending"
              aria-label="Pending command without a verified preview"
              role="status"
            >
              <p>A pending external action has no verified summary. It cannot be approved here.</p>
              <button
                type="button"
                aria-label="Cancel pending action"
                disabled={pendingCancelStatus === 'cancelling'}
                onClick={cancelPendingCommand}
                className="right-edge-sidecar__pending-cancel no-drag focus-ring"
              >
                {pendingCancelStatus === 'cancelling' ? 'Cancelling…' : 'Cancel pending action'}
              </button>
              {pendingCancelStatus === 'cancelled' ? <p>The pending action was cancelled.</p> : null}
              {pendingCancelStatus === 'unavailable' ? <p>That pending action is no longer available.</p> : null}
            </section>
          ) : null}
          {onOpenReader && detailsAvailable ? (
            <button
              type="button"
              aria-label={readerStrings.openDetailsName}
              className="right-edge-sidecar__history no-drag focus-ring"
              data-re-open-reader="details"
              onClick={() => onOpenReader('details')}
            >
              {readerStrings.openDetails}
            </button>
          ) : null}

          <div className="right-edge-sidecar__composer">
            <SidecarChat
              value={value}
              onChange={onChange}
              onSubmit={onSubmit}
              onStop={onStop}
              busy={busy}
              stoppable={stoppable}
              inputRef={composerRef}
              onComposerActivity={onComposerActivity}
              onComposingChange={onComposingChange}
            />
          </div>
        </div>
      </aside>
    </div>
  )
}
