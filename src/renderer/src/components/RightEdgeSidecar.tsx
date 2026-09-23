import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { AudioLines, Brain, ChevronLeft, CornerDownLeft, FileSearch, Image, LoaderCircle, Settings, Square, X } from 'lucide-react'
import type { MetisCommandState } from '@shared/ipc'
import { MantuMark } from './MantuMark'

export const RIGHT_EDGE_TAB_WIDTH = 52
export const RIGHT_EDGE_DRAWER_WIDTH = 360

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
  inputRef
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
        onKeyDown={(event) => {
          // IME uses Enter to commit a composition. Sending then would discard the user's in-progress text.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
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
        {busy ? (stoppable ? <X size={16} strokeWidth={1.9} /> : <LoaderCircle size={16} strokeWidth={1.9} className="right-edge-sidecar__spin" />) : <CornerDownLeft size={16} strokeWidth={1.9} />}
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
      <span className="right-edge-sidecar__action-icon" aria-hidden="true">{children}</span>
      <span className="right-edge-sidecar__action-assist">{status ? `${label}: ${status}` : label}</span>
    </button>
  )
}

function compactLiveNotice(notice: string): string {
  const message = notice.trim()
  if (/^mic silent\b/i.test(message)) return 'Mic silent · check input'
  if (/^microphone input stopped\b/i.test(message)) return 'Mic lost · reconnecting'
  if (/^could(?: not|n['’]t) start the microphone\b/i.test(message)) return 'Mic unavailable · check access'
  if (/^microphone unavailable\. listening to system audio only\./i.test(message)) return 'Mic unavailable · system audio only'
  if (/built-in transcription files/i.test(notice)) return 'Transcription repair'
  return notice
}

export interface RightEdgeDockActions {
  listening?: boolean
  onToggleListen?: () => void
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
}

export function RightEdgeSidecar({
  open,
  onOpen,
  onClose,
  canClose = true,
  commandState = { proposalId: null },
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  stoppable,
  body,
  listening = false,
  onToggleListen,
  capturing = false,
  onCapture,
  onOpenIntelligence,
  onSpotlightRef,
  spotlightReady = false,
  onHistory,
  liveNotice,
  onSettings
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** The dock only offers dismissal when the current overlay state can actually park. */
  canClose?: boolean
  /** Opaque state only. Main has not supplied a verified action preview in this version. */
  commandState?: MetisCommandState
} & SidecarChatProps & RightEdgeDockActions): JSX.Element {
  const [pendingCancel, setPendingCancel] = useState<{
    proposalId: string | null
    status: 'idle' | 'cancelling' | 'cancelled' | 'unavailable'
  }>({ proposalId: null, status: 'idle' })
  const [intelligence, setIntelligence] = useState<{ status: 'idle' | 'opening' | 'error'; error?: string }>({ status: 'idle' })
  const composerRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const cancelPendingCommand = (): void => {
    if (!commandState.proposalId) return
    const proposalId = commandState.proposalId
    setPendingCancel({ proposalId, status: 'cancelling' })
    void window.toto
      .cancelMetisCommand({ proposalId, nonce: commandState.nonce })
      .then((result) => setPendingCancel({ proposalId, status: result.ok ? 'cancelled' : 'unavailable' }))
      .catch(() => setPendingCancel({ proposalId, status: 'unavailable' }))
  }

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

  const pendingCancelStatus =
    commandState.proposalId !== null && pendingCancel.proposalId === commandState.proposalId
      ? pendingCancel.status
      : 'idle'
  const status = capturing ? 'Capturing screen' : listening ? 'Listening' : busy ? 'Thinking' : 'Ready'

  return (
    <div className={'right-edge-sidecar' + (open ? ' right-edge-sidecar--open' : '')}>
      <button
        type="button"
        aria-label="Open Métis"
        aria-expanded={open}
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : 0}
        onClick={onOpen}
        className="right-edge-sidecar__tab no-drag focus-ring"
        style={{ width: RIGHT_EDGE_TAB_WIDTH }}
      >
        <span className="right-edge-sidecar__rail" aria-hidden="true" />
      </button>
      {open ? (
        <aside
          role="complementary"
          aria-label="Métis"
          className="right-edge-sidecar__drawer"
          style={{ maxWidth: RIGHT_EDGE_DRAWER_WIDTH }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && canClose) {
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
                  <button type="button" aria-label="Close Métis" onClick={close} className="right-edge-sidecar__header-back no-drag focus-ring">
                    <ChevronLeft size={18} strokeWidth={1.9} />
                  </button>
                ) : null}
                <span className="right-edge-sidecar__identity">
                  <span>Métis</span>
                </span>
              </span>
              <span className="right-edge-sidecar__status" data-right-edge-status={status} aria-live="polite">
                <span className="right-edge-sidecar__status-dot" aria-hidden="true" />
                <span>{status}</span>
              </span>
            </header>

            {liveNotice ? (
              <p className="right-edge-sidecar__status-notice" role="status" aria-label={liveNotice} title={liveNotice}>
                {compactLiveNotice(liveNotice)}
              </p>
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
                  <span className="right-edge-sidecar__empty-mark"><MantuMark size={22} round /></span>
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
                    {capturing ? <LoaderCircle size={17} strokeWidth={1.9} className="right-edge-sidecar__spin" /> : <Image size={17} strokeWidth={1.9} />}
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
                    {intelligence.status === 'opening' ? <LoaderCircle size={17} strokeWidth={1.9} className="right-edge-sidecar__spin" /> : <Brain size={17} strokeWidth={1.9} />}
                  </DockAction>
                ) : null}
                {onToggleListen ? <span className="right-edge-sidecar__action-divider" aria-hidden="true" /> : null}
                {onToggleListen ? (
                  <DockAction
                    label={listening ? 'Stop meeting' : 'Start listening'}
                    status={listening ? 'Listening' : undefined}
                    onClick={onToggleListen}
                    active={listening}
                  >
                    {listening ? <Square size={16} strokeWidth={1.9} /> : <AudioLines size={17} strokeWidth={1.9} />}
                  </DockAction>
                ) : null}
                {onHistory ? (
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

            {intelligence.status === 'error' ? <p className="right-edge-sidecar__notice" role="status">{intelligence.error}</p> : null}
            {commandState.proposalId ? (
              <section className="right-edge-sidecar__pending" aria-label="Pending command without a verified preview" role="status">
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

            <div className="right-edge-sidecar__composer">
              <SidecarChat
                value={value}
                onChange={onChange}
                onSubmit={onSubmit}
                onStop={onStop}
                busy={busy}
                stoppable={stoppable}
                inputRef={composerRef}
              />
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  )
}
