import { useEffect, useState } from 'react'
import type { MetisCommandState } from '@shared/ipc'
import { useCommandMic } from '../lib/use-command-mic'

export const RIGHT_EDGE_TAB_WIDTH = 52
export const RIGHT_EDGE_DRAWER_WIDTH = 360

export function RightEdgeSidecar({
  open,
  onOpen,
  onClose,
  commandState = { proposalId: null },
  meetingListening = false
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** Opaque state only. Main has not supplied a verified action preview in this version. */
  commandState?: MetisCommandState
  /** Reserves microphone access for the active meeting before its stream has finished acquiring. */
  meetingListening?: boolean
}): JSX.Element {
  const { status, reason, start, cancel } = useCommandMic({ maxDurationMs: 8_000 })
  const [pendingCancel, setPendingCancel] = useState<{
    proposalId: string | null
    status: 'idle' | 'cancelling' | 'cancelled' | 'unavailable'
  }>({ proposalId: null, status: 'idle' })

  useEffect(() => {
    if (!open && (status === 'starting' || status === 'listening')) cancel()
  }, [cancel, open, status])

  // Meeting Listen sets this before getUserMedia settles. Releasing a command lease here and blocking
  // its start path prevents a second mic acquisition without inspecting or sharing meeting audio.
  useEffect(() => {
    if (meetingListening && (status === 'starting' || status === 'listening')) cancel()
  }, [cancel, meetingListening, status])

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
    cancel()
    cancelPendingCommand()
    onClose()
  }

  const commandMicUnavailable = meetingListening || status === 'starting' || status === 'listening'
  const startCommandMic = (): void => {
    if (commandMicUnavailable) return
    void start()
  }

  const commandMicCopy =
    meetingListening
      ? 'A meeting is currently listening, so the command microphone check is unavailable until the meeting stops.'
      : status === 'starting'
      ? 'Opening microphone access check…'
      : status === 'listening'
        ? 'Microphone access is active for up to 8 seconds. This build does not yet interpret or save speech.'
        : status === 'finalizing'
          ? 'Microphone released. No action has been proposed.'
          : status === 'error'
            ? reason === 'microphone_unavailable'
              ? 'Métis could not access your microphone. Check the system permission, then try again.'
              : 'Métis could not start the microphone access check.'
            : 'No action has been proposed yet. Test microphone access when you are ready.'
  const pendingCancelStatus =
    commandState.proposalId !== null && pendingCancel.proposalId === commandState.proposalId
      ? pendingCancel.status
      : 'idle'

  return (
    <div className={'right-edge-sidecar' + (open ? ' right-edge-sidecar--open' : '')}>
      <button
        type="button"
        aria-label="Open Métis"
        aria-expanded={open}
        onClick={onOpen}
        className="right-edge-sidecar__tab no-drag focus-ring"
        style={{ width: RIGHT_EDGE_TAB_WIDTH }}
      >
        Métis
      </button>
      {open ? (
        <aside
          role="complementary"
          aria-label="Métis command"
          className="right-edge-sidecar__drawer"
          style={{ width: RIGHT_EDGE_DRAWER_WIDTH }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        >
          <div className="right-edge-sidecar__drawer-scroll">
            <div className="right-edge-sidecar__heading">Métis command</div>
            <p data-metis-command-mic-status="1" role="status">{commandMicCopy}</p>
            <button
              type="button"
              aria-label="Test microphone access"
              disabled={commandMicUnavailable}
              onClick={startCommandMic}
              className="no-drag focus-ring"
            >
              {status === 'starting' || status === 'listening' ? 'Testing microphone…' : 'Test microphone access'}
            </button>
            {commandState.proposalId ? (
              <section aria-label="Pending command without a verified preview" role="status">
                <p>
                  Métis has a pending command, but no verified action summary was supplied. It cannot be confirmed safely.
                </p>
                <button
                  type="button"
                  aria-label="Cancel pending action"
                  disabled={pendingCancelStatus === 'cancelling'}
                  onClick={cancelPendingCommand}
                  className="no-drag focus-ring"
                >
                  {pendingCancelStatus === 'cancelling' ? 'Cancelling…' : 'Cancel pending action'}
                </button>
                {pendingCancelStatus === 'cancelled' ? <p>The pending action was cancelled.</p> : null}
                {pendingCancelStatus === 'unavailable' ? <p>That pending action is no longer available.</p> : null}
              </section>
            ) : null}
            <button type="button" onClick={close} className="no-drag focus-ring">Close</button>
          </div>
        </aside>
      ) : null}
    </div>
  )
}
