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
 * Fixed-size sentient 52 Fit Studio glass sphere. Never a stadium pill.
 * Docked on the idle Bar (click minimizes) or alone when minimized (click expands).
 */
export function JarvisOrbButton({
  onActivate,
  orbMood = 'idle',
  listening = false,
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false
}: {
  onActivate: () => void
  orbMood?: OrbMood
  listening?: boolean
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
    const orb = mountBarPillOrb(canvas, { mood: orbMood, listening, reducedMotion: reduced })
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

  useEffect(() => {
    orbRef.current?.setListening(listening)
  }, [listening])

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
      data-orb-listening={listening || undefined}
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
      {listening ? <span className="aw-orb__rec rec-dot" data-orb-rec aria-hidden="true" /> : null}
    </button>
  )
}
