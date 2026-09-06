import { useEffect, useRef } from 'react'
import { useWindowDrag } from '../lib/window-drag'
import { BAR_PILL_VISIBLE_PX, pillClickShouldExpand, type OrbMood } from '../lib/bar-pill-orb'
import {
  createJarvisObsidianOrb,
  resolveJarvisOrbState,
  type JarvisObsidianOrbHandle
} from '../lib/jarvis-obsidian-orb'

/**
 * Jarvis circle. Real Three.js particle cloud + lines + electrons (tonys-jarvis).
 * Same 41 host. Not CSS rings. Not a gray box.
 */
export function ObsidianOrb({
  onActivate,
  title,
  ariaLabel,
  enableDrag = false,
  hugWidth = false,
  orbMood = 'idle',
  listening = false
}: {
  onActivate: () => void
  title: string
  ariaLabel: string
  enableDrag?: boolean
  hugWidth?: boolean
  orbMood?: OrbMood
  listening?: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<JarvisObsidianOrbHandle | null>(null)
  const dragMovedRef = useRef(false)
  const orbState = resolveJarvisOrbState({ mood: orbMood, listening })
  const startStateRef = useRef(orbState)
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
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    handleRef.current = createJarvisObsidianOrb(canvas, {
      reducedMotion: reduced,
      state: startStateRef.current
    })
    return () => {
      handleRef.current?.dispose()
      handleRef.current = null
    }
  }, [])

  useEffect(() => {
    handleRef.current?.setState(orbState)
  }, [orbState])

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
        if (enableDrag && !pillClickShouldExpand(dragMovedRef.current)) return
        onActivate()
      }}
      className="aw-orb aw-orb--obsidian no-drag focus-ring"
    >
      <span className="obsidian-orb" aria-hidden="true">
        <canvas
          ref={canvasRef}
          className="obsidian-orb__canvas"
          width={BAR_PILL_VISIBLE_PX * 2}
          height={BAR_PILL_VISIBLE_PX * 2}
        />
      </span>
    </button>
  )
}
