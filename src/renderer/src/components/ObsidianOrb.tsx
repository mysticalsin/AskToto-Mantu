import { useEffect, useLayoutEffect, useRef } from 'react'
import { useWindowDrag } from '../lib/window-drag'
import { BAR_PILL_VISIBLE_PX, runOrbPillActivate, type OrbMood } from '../lib/bar-pill-orb'
import { createJarvisOrb, resolveJarvisOrbState, type JarvisOrbHandle } from '../lib/jarvis-orb'

/**
 * Jarvis circle. Real tonys-jarvis / jarvis2.0 particle cloud, sized to the 41 pill.
 * Not CSS rings. Not a gray box. Not a static Métis M.
 */
export function ObsidianOrb({
  onActivate,
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false,
  orbMood = 'idle',
  listening = false,
  preview = false
}: {
  onActivate: () => void
  title: string
  ariaLabel: string
  enableDrag?: boolean
  hugWidth?: boolean
  orbMood?: OrbMood
  listening?: boolean
  /** Settings card: same particle orb as Bar, not a button. */
  preview?: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<JarvisOrbHandle | null>(null)
  const dragMovedRef = useRef(false)
  const orbState = resolveJarvisOrbState({ mood: orbMood, listening })
  const startStateRef = useRef(orbState)
  const drag = useWindowDrag(
    () => {
      dragMovedRef.current = true
    },
    { armOnControls: true, deadZonePx: 14 }
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Brand chrome: always animate. Windows "Show animations" off maps to
    // prefers-reduced-motion and was freezing the Jarvis pill to one frame.
    handleRef.current = createJarvisOrb(canvas, {
      reducedMotion: false,
      state: startStateRef.current,
      hostPx: BAR_PILL_VISIBLE_PX
    })
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
    }
  }, [])

  useEffect(() => {
    handleRef.current?.setState(orbState)
  }, [orbState])

  const orb = (
    <span className="obsidian-orb" aria-hidden="true">
      <canvas
        ref={canvasRef}
        className="obsidian-orb__canvas"
        width={BAR_PILL_VISIBLE_PX * 2}
        height={BAR_PILL_VISIBLE_PX * 2}
      />
    </span>
  )

  if (preview) {
    return (
      <span
        className="aw-orb aw-orb--obsidian no-drag"
        data-bar-pill-orb
        data-orb-preview
        data-orb-style="obsidian"
        data-orb-engine="jarvis-particles"
        data-orb-diagram-engine="jarvis-particles"
        data-orb-state={orbState}
        data-orb-visible={BAR_PILL_VISIBLE_PX}
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
      data-orb-style="obsidian"
      data-orb-engine="jarvis-particles"
      data-orb-state={orbState}
      data-orb-visible={BAR_PILL_VISIBLE_PX}
      title={title}
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        dragMovedRef.current = false
        if (enableDrag) drag.onPointerDown(e)
      }}
      onClick={() => {
        runOrbPillActivate({ enableDrag, dragMoved: dragMovedRef.current, onActivate })
      }}
      className="aw-orb aw-orb--obsidian no-drag focus-ring"
    >
      {orb}
    </button>
  )
}
