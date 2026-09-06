import { useLayoutEffect, useRef } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { useWindowDrag } from '../lib/window-drag'
import { paintOrbFirstFrame } from '../lib/orb-first-frame'
import {
  BAR_ORB_SPEED,
  BAR_ORB_THEME,
  BAR_PILL_BACKING_DPR,
  BAR_PILL_BACKING_PX,
  BAR_PILL_SIZE_PX,
  BAR_PILL_VISIBLE_PX,
  runOrbPillActivate,
  resolveBarOrbState,
  shouldShowOrbRecDot,
  type OrbMood
} from '../lib/bar-pill-orb'

/**
 * Thinking-orb circle. Package canvas stays 64 (avatar) with 2x backing.
 * Visible host is 41. Never a muddy 1x CSS downscale. Never a stadium pill.
 */
export function JarvisOrbButton({
  onActivate,
  orbMood = 'idle',
  listening = false,
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false,
  preview = false
}: {
  onActivate: () => void
  orbMood?: OrbMood
  listening?: boolean
  title: string
  ariaLabel: string
  enableDrag?: boolean
  hugWidth?: boolean
  /** Settings card: same ThinkingOrb as Bar, not a button, not the 22px CSS disc. */
  preview?: boolean
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
    paintOrbFirstFrame(canvas, orbState, BAR_PILL_SIZE_PX, true, BAR_PILL_BACKING_DPR)
  }, [orbState])

  const orb = (
    <>
      <span
        ref={hostRef}
        className={preview ? 'overlay-orb-diagram__jakub-host aw-orb__host' : 'aw-orb__host'}
        aria-hidden="true"
      >
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
    </>
  )

  if (preview) {
    return (
      <span
        className="overlay-orb-diagram__jakub--live aw-orb no-drag"
        data-bar-pill-orb
        data-orb-preview
        data-orb-diagram-engine="thinking-orbs"
        data-orb-mood={orbMood}
        data-orb-state={orbState}
        data-orb-visible={BAR_PILL_VISIBLE_PX}
        data-orb-backing={BAR_PILL_BACKING_PX}
        aria-hidden="true"
      >
        {orb}
      </span>
    )
  }

  return (
    <button
      {...(enableDrag ? drag : {})}
      type="button"
      data-hug-width={hugWidth || undefined}
      data-bar-pill-orb
      data-orb-mood={orbMood}
      data-orb-state={orbState}
      data-orb-visible={BAR_PILL_VISIBLE_PX}
      data-orb-backing={BAR_PILL_BACKING_PX}
      data-orb-listening={listening || undefined}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragMovedRef.current = false
        if (enableDrag) drag.onPointerDown(e)
      }}
      onClick={() => {
        runOrbPillActivate({ enableDrag, dragMoved: dragMovedRef.current, onActivate })
      }}
      className="aw-orb no-drag focus-ring"
    >
      {orb}
    </button>
  )
}
