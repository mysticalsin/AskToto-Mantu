import { useLayoutEffect, useRef } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { useWindowDrag } from '../lib/window-drag'
import { paintOrbFirstFrame } from '../lib/orb-first-frame'
import {
  BAR_ORB_SPEED,
  BAR_ORB_THEME,
  BAR_PILL_SIZE_PX,
  pillClickShouldExpand,
  resolveBarOrbState,
  shouldShowOrbRecDot,
  type OrbMood
} from '../lib/bar-pill-orb'

/**
 * Fixed 64 thinking-orb circle. Never a stadium pill.
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
  const hostRef = useRef<HTMLSpanElement>(null)
  const dragMovedRef = useRef(false)
  const orbState = resolveBarOrbState({ mood: orbMood, listening })
  const showRec = shouldShowOrbRecDot(listening)

  const drag = useWindowDrag(
    () => {
      dragMovedRef.current = true
    },
    { armOnControls: true, deadZonePx: 14 }
  )

  useLayoutEffect(() => {
    const canvas = hostRef.current?.querySelector('canvas')
    if (!canvas) return
    paintOrbFirstFrame(canvas, orbState, BAR_PILL_SIZE_PX, true)
  }, [orbState])

  return (
    <button
      {...(enableDrag ? drag : {})}
      type="button"
      data-hug-width={hugWidth || undefined}
      data-bar-pill-orb
      data-orb-mood={orbMood}
      data-orb-state={orbState}
      data-orb-listening={listening || undefined}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragMovedRef.current = false
        if (enableDrag) drag.onPointerDown(e)
      }}
      onClick={() => {
        if (enableDrag && !pillClickShouldExpand(dragMovedRef.current)) return
        onActivate()
      }}
      className="aw-orb no-drag focus-ring"
    >
      <span ref={hostRef} className="aw-orb__host" aria-hidden="true">
        <ThinkingOrb
          state={orbState}
          size={BAR_PILL_SIZE_PX}
          theme={BAR_ORB_THEME}
          speed={BAR_ORB_SPEED}
          className="aw-orb__canvas"
          aria-hidden="true"
          aria-label=""
        />
      </span>
      {showRec ? <span className="aw-orb__rec rec-dot" data-orb-rec aria-hidden="true" /> : null}
    </button>
  )
}
