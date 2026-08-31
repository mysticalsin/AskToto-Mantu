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
 * Fixed-size sentient circle (Fit Studio 52×52). Never a stadium pill.
 * Docked on the idle Bar (click minimizes) or alone when minimized (click expands).
 */
export function JarvisOrbButton({
  onActivate,
  orbMood = 'idle',
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false
}: {
  onActivate: () => void
  orbMood?: OrbMood
  title: string
  ariaLabel: string
  enableDrag?: boolean
  hugWidth?: boolean
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
    if (dragMovedRef.current) return
    const nx = (e.nativeEvent.offsetX / BAR_PILL_SIZE_PX) * 2 - 1
    const ny = (e.nativeEvent.offsetY / BAR_PILL_SIZE_PX) * 2 - 1
    orbRef.current?.setHover(nx, ny, true)
  }

  return (
    <button
      {...(enableDrag ? drag : {})}
      type="button"
      data-hug-width={hugWidth || undefined}
      data-bar-pill-orb
      data-orb-mood={orbMood}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragMovedRef.current = false
        if (enableDrag) drag.onPointerDown(e)
      }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => orbRef.current?.setHover(0, 0, false)}
      onClick={() => {
        if (enableDrag && !pillClickShouldExpand(dragMovedRef.current)) return
        onActivate()
      }}
      className="aw-orb no-drag focus-ring"
    >
      <canvas
        ref={canvasRef}
        className="aw-orb__canvas"
        width={BAR_PILL_SIZE_PX * 2}
        height={BAR_PILL_SIZE_PX * 2}
        aria-hidden="true"
      />
    </button>
  )
}
