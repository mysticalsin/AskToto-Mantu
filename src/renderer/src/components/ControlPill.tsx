import { useEffect, useRef } from 'react'
import { useWindowDrag } from '../lib/window-drag'
import {
  BAR_PILL_HEIGHT_PX,
  BAR_PILL_WIDTH_PX,
  mountBarPillOrb,
  moodFromListen,
  pillClickShouldExpand,
  type BarPillOrbHandle,
  type BarPillOrbMood
} from '../lib/bar-pill-orb'

/**
 * Bar minimized control: Jarvis sentient particle capsule.
 * Click (not drag) expands to the full bar. Listen mood lives in the orb, not a chip of buttons.
 */
export function ControlPill({
  onExpand,
  listening,
  paused,
  degradedNote
}: {
  onExpand: () => void
  onHide: () => void
  onToggleListen: () => void
  onTogglePause: () => void
  listening: boolean
  paused: boolean
  degradedNote?: string | null
  startedAt: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const orbRef = useRef<BarPillOrbHandle | null>(null)
  const dragMovedRef = useRef(false)
  const mood: BarPillOrbMood = moodFromListen(listening, paused, !!degradedNote)

  const drag = useWindowDrag(
    () => {
      dragMovedRef.current = true
    },
    { armOnControls: true, deadZonePx: 14 }
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const orb = mountBarPillOrb(canvas, { mood, reducedMotion: reduced })
    orbRef.current = orb
    return () => {
      orb.destroy()
      orbRef.current = null
    }
    // Mount once; mood/hover update through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    orbRef.current?.setMood(mood)
  }, [mood])

  return (
    <button
      {...drag}
      type="button"
      data-hug-width
      data-bar-pill-orb
      data-orb-mood={mood}
      title={degradedNote || 'Expand Métis'}
      aria-label="Expand Métis"
      className="aw-pill aw-pill--orb no-drag focus-ring"
      onPointerDown={() => {
        dragMovedRef.current = false
      }}
      onPointerMove={(e) => {
        if (dragMovedRef.current) return
        const nx = (e.nativeEvent.offsetX / BAR_PILL_WIDTH_PX) * 2 - 1
        const ny = (e.nativeEvent.offsetY / BAR_PILL_HEIGHT_PX) * 2 - 1
        orbRef.current?.setHover(nx, ny, true)
      }}
      onPointerLeave={() => orbRef.current?.setHover(0, 0, false)}
      onClick={() => {
        if (pillClickShouldExpand(dragMovedRef.current)) onExpand()
      }}
    >
      <canvas ref={canvasRef} className="aw-pill-orb" width={BAR_PILL_WIDTH_PX} height={BAR_PILL_HEIGHT_PX} />
    </button>
  )
}
