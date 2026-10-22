/**
 * VoiceActionsLayer.tsx — the one renderer surface for a hold-to-talk voice turn (V05, design §1.3–§1.7).
 *
 * Main owns the turn; this layer only renders main's snapshot as the pill. It never takes focus (HIG: a status,
 * not a dialog), never opens the microphone and never starts anything. Under the top-center bar it sits in the
 * overlay root's normal flow, so the window grows to fit it (useAutoResize measures the root); beside the
 * right-edge dock it leans out of the dock's vertical center.
 *
 * Motion is token-only (tokens.css, overlay-motion.css): the pill enters with the peek geometry at 150 ms,
 * morphs width on state change, and leaves with the overlay spring-out. Reduced motion zeroes the movement and
 * keeps only an opacity breathe on the listening bars, a liveness and consent signal like the recording dot.
 */
import { useEffect, useRef, useState } from 'react'
import type { VoiceStateSnapshot } from '@shared/voice/voice-turn'
import { playCue } from '../../lib/sound'
import { type VoicePillView, voiceCueFor, voicePillView } from './voice-pill-model'

/** The exit leg; matches overlay-spring-out (280 ms) so the pill and the overlay leave alike. */
export const VOICE_PILL_EXIT_MS = 280

type Bridge = {
  getState(): Promise<VoiceStateSnapshot | null>
  onState(cb: (state: VoiceStateSnapshot) => void): () => void
}

function voiceBridge(): Bridge | null {
  const bridge = (window as unknown as { toto?: { voiceActions?: Bridge } }).toto?.voiceActions
  return bridge && typeof bridge.onState === 'function' ? bridge : null
}

/** Latest snapshot from main; a stale revision never replaces a newer one. */
export function useVoiceSnapshot(bridge: Bridge | null = voiceBridge()): VoiceStateSnapshot | null {
  const [snapshot, setSnapshot] = useState<VoiceStateSnapshot | null>(null)
  useEffect(() => {
    if (!bridge) return
    let live = true
    const accept = (next: VoiceStateSnapshot | null): void => {
      if (!live || !next) return
      setSnapshot((current) => (current && current.revision > next.revision ? current : next))
    }
    const off = bridge.onState(accept)
    void bridge
      .getState()
      .then(accept)
      .catch(() => {})
    return () => {
      live = false
      off()
    }
  }, [bridge])
  return snapshot
}

function Glyph({ glyph }: { glyph: VoicePillView['glyph'] }): JSX.Element {
  if (glyph === 'listening') {
    return (
      <span className="voice-pill__bars" aria-hidden>
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

export function VoiceActionsLayer({
  placement,
  soundCues,
  hintsShown = 0,
  snapshot: provided,
  now = () => Date.now()
}: {
  placement: 'top-center' | 'right-edge'
  soundCues: boolean
  hintsShown?: number
  /** Tests and stories pass a snapshot; the app reads main's. */
  snapshot?: VoiceStateSnapshot | null
  now?: () => number
}): JSX.Element | null {
  const live = useVoiceSnapshot(provided === undefined ? voiceBridge() : null)
  const snapshot = provided === undefined ? live : provided
  const next = voicePillView(snapshot, hintsShown)

  // Keep the last visible view through the exit leg, and let a terminal state leave on its own hold timer
  // even if main is slow to move back to idle.
  const [shown, setShown] = useState<VoicePillView | null>(next)
  const [leaving, setLeaving] = useState(false)
  const previousState = useRef<VoicePillView['state'] | null>(null)
  const heldSince = useRef<number>(0)

  useEffect(() => {
    if (!next) {
      previousState.current = null
      setLeaving((was) => was || shown !== null)
      return
    }
    if (previousState.current !== next.state) {
      const cue = voiceCueFor(previousState.current, next.state)
      if (cue && soundCues) playCue(cue)
      heldSince.current = now()
    }
    previousState.current = next.state
    setShown(next)
    setLeaving(false)
    // `next` is derived from the snapshot each render; its state, title and detail are its identity here.
  }, [next?.state, next?.title, next?.detail, soundCues])

  // A terminal state leaves on its own hold even if main is slow to move back to idle.
  useEffect(() => {
    if (!shown || leaving || shown.holdMs === null) return
    const remaining = Math.max(0, shown.holdMs - (now() - heldSince.current))
    const t = window.setTimeout(() => setLeaving(true), remaining)
    return () => window.clearTimeout(t)
  }, [shown, leaving])

  // The exit leg: the pill plays overlay-spring-out, then unmounts. A new state during the leg cancels it.
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(() => {
      setShown(null)
      setLeaving(false)
    }, VOICE_PILL_EXIT_MS)
    return () => window.clearTimeout(t)
  }, [leaving])

  if (!shown) return null
  return (
    <div className={`voice-layer voice-layer--${placement}`} data-voice-placement={placement}>
      <div
        className={`voice-pill${leaving ? ' voice-pill--leaving' : ''}`}
        data-voice-state={shown.state}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Glyph glyph={shown.glyph} />
        <span className="voice-pill__text">
          <span className="voice-pill__title">{shown.title}</span>
          {shown.detail ? <span className="voice-pill__detail">{shown.detail}</span> : null}
        </span>
      </div>
    </div>
  )
}
