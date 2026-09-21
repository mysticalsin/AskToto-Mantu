/**
 * Métis 2.0 Cap 2 — top-center command listen surface (wake UX).
 * On Hey Métis: Obsidian/Jarvis particle orb APPEARS and turns (listening state).
 * Copy rides beside; does not replace Bar ControlPill / Hide / Island.
 */
import { useEffect, useRef } from 'react'
import { ObsidianOrb } from './ObsidianOrb'

export type CommandListeningPillProps = {
  visible: boolean
  copy: string
  liveTranscript: string
  chime: 'none' | 'single' | 'double'
  onStop?: () => void
}

function playChime(kind: 'single' | 'double'): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const beep = (at: number, freq: number): void => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.value = 0.0001
      g.gain.exponentialRampToValueAtTime(0.08, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18)
      o.connect(g)
      g.connect(ctx.destination)
      o.start(at)
      o.stop(at + 0.2)
    }
    const t0 = ctx.currentTime + 0.01
    beep(t0, 880)
    if (kind === 'double') beep(t0 + 0.22, 660)
    window.setTimeout(() => void ctx.close(), 800)
  } catch {
    /* ignore */
  }
}

export function CommandListeningPill({
  visible,
  copy,
  liveTranscript,
  chime,
  onStop
}: CommandListeningPillProps): JSX.Element | null {
  const lastChime = useRef<'none' | 'single' | 'double'>('none')

  useEffect(() => {
    if (chime !== 'none' && chime !== lastChime.current) {
      playChime(chime)
    }
    lastChime.current = chime
  }, [chime])

  useEffect(() => {
    if (!visible || !onStop) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onStop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, onStop])

  if (!visible) return null

  const transcript = liveTranscript.trim()
  const showLive = transcript.length > 0 && copy.includes('listening')

  return (
    <div
      data-metis-command-pill="1"
      data-metis-command-listen-orb="1"
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed left-1/2 top-3 z-[80] flex max-w-[min(560px,92vw)] -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-black/55 px-4 py-2.5 text-[13px] text-white/95 shadow-lg backdrop-blur-md"
    >
      {/* Cap4 Jarvis particle sphere — must visibly turn in listening state (Tony HARD). */}
      <ObsidianOrb
        listening
        animate
        orbMood="idle"
        title="Listening"
        ariaLabel="Métis is listening"
        onActivate={() => onStop?.()}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium tracking-tight">{copy}</div>
        {showLive ? (
          <div className="truncate text-[11px] text-white/70" data-metis-command-transcript="1">
            {transcript}
          </div>
        ) : null}
      </div>
      {onStop ? (
        <button
          type="button"
          aria-label="Stop command listening"
          className="no-drag shrink-0 rounded-full px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/10 hover:text-white"
          onClick={onStop}
        >
          Esc
        </button>
      ) : null}
    </div>
  )
}
