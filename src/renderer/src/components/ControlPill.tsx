import { useEffect, useRef } from 'react'
import { useWindowDrag } from '../lib/window-drag'
import {
  BAR_PILL_SIZE_PX,
  mountBarPillOrb,
  pillClickShouldExpand,
  type BarPillOrbHandle,
  type OrbMood
} from '../lib/bar-pill-orb'

/**
 * Bar-only minimized control: Fit Studio sentient circle.
 * Click (not drag) expands to the full bar. Hide/Island never mount this.
 */
export function ControlPill({
  onExpand,
  orbMood = 'idle',
  degradedNote
}: {
  onExpand: () => void
  orbMood?: OrbMood
  /** Tooltip only. Rec-dot stays elsewhere; do not paint this sphere red. */
  degradedNote?: string | null
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const orbRef = useRef<BarPillOrbHandle | null>(null)
  const dragMovedRef = useRef(false)

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
    const orb = mountBarPillOrb(canvas, { mood: orbMood, reducedMotion: reduced })
    orbRef.current = orb
    return () => {
      orb.destroy()
      orbRef.current = null
    }
    // Mount once; mood/hover update through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    orbRef.current?.setMood(orbMood)
  }, [orbMood])

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    // Skip lean while dragging — do not measure, do not fight moveBy.
    if (dragMovedRef.current) return
    const nx = (e.nativeEvent.offsetX / BAR_PILL_SIZE_PX) * 2 - 1
    const ny = (e.nativeEvent.offsetY / BAR_PILL_SIZE_PX) * 2 - 1
    orbRef.current?.setHover(nx, ny, true)
  }

  return (
    <button
      {...drag}
      type="button"
      data-hug-width
      data-bar-pill-orb
      data-orb-mood={orbMood}
      title={degradedNote || 'Expand Métis'}
      aria-label="Expand Métis"
      onPointerDown={(e) => {
        dragMovedRef.current = false
        drag.onPointerDown(e)
      }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => orbRef.current?.setHover(0, 0, false)}
      onClick={() => {
        if (!pillClickShouldExpand(dragMovedRef.current)) return
        onExpand()
      }}
      className="aw-pill aw-pill--orb focus-ring"
    >
      <canvas
        ref={canvasRef}
        className="aw-pill-orb"
        width={BAR_PILL_SIZE_PX * 2}
        height={BAR_PILL_SIZE_PX * 2}
        aria-hidden="true"
      />
    </button>
  )
}
