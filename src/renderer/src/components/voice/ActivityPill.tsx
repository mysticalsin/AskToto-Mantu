import { useEffect, useState } from 'react'
import {
  activityPillView,
  type ActivityAction,
  type ActivityPillView,
  type ConversationStatusInput,
  type DictationStatusInput,
  type SpokenReplyStatusInput
} from './activity-pill-model'
import { createSnapshotOrder } from './snapshot-order'

/**
 * The top-edge activity pill (G30): dictation, a continuous conversation and a spoken reply, in the V05 pill's place
 * and shape. It is a status, not a dialog: it never takes focus; its only control is the one Stop that works now.
 * Each feature's bridge is optional — a feature that is not built or not enabled simply never shows.
 */

type Unsub = () => void
interface StateBridge<T> {
  getState(): Promise<T | null>
  onState(cb: (state: T) => void): Unsub
}

interface ActivityBridges {
  dictation?: StateBridge<DictationStatusInput>
  conversation?: StateBridge<ConversationStatusInput> & { stop(): Promise<unknown> }
  spokenReply?: StateBridge<SpokenReplyStatusInput> & { stop(): Promise<unknown> }
}

function liveBridges(): ActivityBridges {
  if (typeof window === 'undefined') return {}
  const toto = (window as unknown as { toto?: Record<string, unknown> }).toto ?? {}
  const pick = <T,>(value: unknown): T | undefined =>
    value && typeof (value as { onState?: unknown }).onState === 'function' ? (value as T) : undefined
  return {
    dictation: pick(toto.dictationStatus),
    conversation: pick(toto.conversation),
    spokenReply: pick(toto.spokenReplies)
  }
}

function useBridgeState<T>(bridge: StateBridge<T> | undefined): T | null {
  const [state, setState] = useState<T | null>(null)
  useEffect(() => {
    if (!bridge) return
    let live = true
    // A late getState reply must not overwrite a newer push (Codex G30 review P1).
    const order = createSnapshotOrder()
    const off = bridge.onState((next) => {
      if (live && order.push(next)) setState(next)
    })
    void bridge
      .getState()
      .then((next) => {
        if (live && order.pull(next)) setState(next)
      })
      .catch(() => {})
    return () => {
      live = false
      off()
    }
  }, [bridge])
  return state
}

/** Re-renders once a second only while a countdown is on screen; otherwise it does no work (no idle CPU). */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(t)
  }, [active])
  return now
}

export function ActivityPill({
  placement,
  bridges: provided
}: {
  placement: 'top-center' | 'right-edge'
  /** Tests pass bridges; the app reads `window.toto`. */
  bridges?: ActivityBridges
}): JSX.Element | null {
  const [bridges] = useState<ActivityBridges>(() => provided ?? liveBridges())
  const dictation = useBridgeState(bridges.dictation)
  const conversation = useBridgeState(bridges.conversation)
  const spokenReply = useBridgeState(bridges.spokenReply)
  const now = useTicker(Boolean(conversation?.active))
  const view = activityPillView({ dictation, conversation, spokenReply, now })
  const [hidden, setHidden] = useState<string | null>(null)

  // A terminal state leaves on its own hold, even if main is slow to move on.
  useEffect(() => {
    if (!view || view.holdMs === null) return
    const key = view.key
    const t = window.setTimeout(() => setHidden(key), view.holdMs)
    return () => window.clearTimeout(t)
  }, [view?.key, view?.holdMs])

  if (!view || hidden === view.key) return null
  const act = (kind: ActivityAction): void => {
    const target = kind === 'stop-conversation' ? bridges.conversation : bridges.spokenReply
    void target?.stop().catch(() => {})
  }
  return <ActivityPillBody view={view} placement={placement} onAction={act} />
}

export function ActivityPillBody({
  view,
  placement,
  onAction
}: {
  view: ActivityPillView
  placement: 'top-center' | 'right-edge'
  onAction: (kind: ActivityAction) => void
}): JSX.Element {
  return (
    <div className={`voice-layer voice-layer--${placement}`} data-activity-source={view.source}>
      <div
        className="voice-pill activity-pill"
        data-activity-state={view.key}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <ActivityGlyph glyph={view.glyph} />
        <span className="voice-pill__text">
          <span className="voice-pill__title">{view.title}</span>
          {view.detail ? <span className="voice-pill__detail">{view.detail}</span> : null}
        </span>
        {view.action ? (
          <button
            type="button"
            className="activity-pill__action no-drag focus-ring"
            aria-label={view.source === 'conversation' ? 'Stop conversation' : 'Stop reading aloud'}
            onClick={() => onAction(view.action!.kind)}
          >
            {view.action.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ActivityGlyph({ glyph }: { glyph: ActivityPillView['glyph'] }): JSX.Element {
  if (glyph === 'listening' || glyph === 'speaking') {
    return (
      <span className={`voice-pill__bars${glyph === 'speaking' ? ' activity-pill__bars--speaking' : ''}`} aria-hidden>
        <span />
        <span />
        <span />
      </span>
    )
  }
  if (glyph === 'working') return <span className="voice-pill__ring rainbow-ring" aria-hidden />
  if (glyph === 'done') {
    return (
      <svg className="voice-pill__check" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className="voice-pill__info" width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor" />
    </svg>
  )
}
