import { useEffect, useRef, type MutableRefObject } from 'react'
import type { AnswerState } from '../state'
import { playClick, playCue, setSoundsEnabled } from './sound'

/**
 * The interface-sound effects of the overlay, in the order App ran them inline: a cue when an Ask answer
 * finishes or fails, the master "Interface sounds" switch, and one global soft click on any button press.
 *
 * `cancelled` is set by App when the user explicitly stops an answer; it suppresses the chime for that
 * turn and is cleared here once streaming ends. Live copilot suggestions stay silent (ambient).
 */
export function useAppSoundCues(
  askAnswer: AnswerState | null,
  soundCues: boolean | undefined,
  uiSounds: boolean | undefined,
  cancelled: MutableRefObject<boolean>
): void {
  // Ambient auto-answer stays until Tony clicks (clearAnswer / back) or a new question replaces it
  // (new user ask, or a new ambient suggestion). No TTL. No max-age. Never auto-send.
  // Subtle sound cue when an Ask answer finishes (ready) or fails (error). Fires once on the
  // streaming→done edge, gated by the soundCues setting.
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    const a = askAnswer
    const streaming = a?.streaming ?? false
    if (prevStreamingRef.current && !streaming && a) {
      // Only chime on a real completion/error — not when the user cancelled (streaming cleared, no error).
      if (!cancelled.current && (soundCues ?? true)) {
        playCue(a.error ? 'error' : 'ready')
      }
    }
    if (!streaming) cancelled.current = false
    prevStreamingRef.current = streaming
  }, [askAnswer, soundCues])

  // Master interface-sounds switch (default on): keep the sound module in sync with the setting.
  useEffect(() => {
    setSoundsEnabled(uiSounds ?? true)
  }, [uiSounds])

  // Soft click feedback on any button press — one global listener; playClick() self-gates on the master
  // setting, so turning "Interface sounds" off silences it everywhere.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && el.closest('button')) playClick()
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [])
}
