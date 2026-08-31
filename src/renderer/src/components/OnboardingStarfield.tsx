/**
 * Full-bleed Starfield Close canvas under the exclusive tour UI.
 * Retired. After hero the bed is OnboardingConstellation (2D canvas).
 * shouldMountStarfield is always false. Kept so the three.js engine stays unused.
 * pointer-events: none. Canvas stays opacity 0 until the first composed frame.
 */
import { useEffect, useRef } from 'react'
import { createStarfieldBed, type StarfieldBed } from '../lib/onboarding-starfield-engine'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function OnboardingStarfield({
  pulse,
  onUnavailable,
  onFirstFrame
}: {
  pulse: number
  onUnavailable: () => void
  onFirstFrame?: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const bedRef = useRef<StarfieldBed | null>(null)
  const onUnavailableRef = useRef(onUnavailable)
  const onFirstFrameRef = useRef(onFirstFrame)
  onUnavailableRef.current = onUnavailable
  onFirstFrameRef.current = onFirstFrame

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.opacity = '0'
    wrap.appendChild(canvas)
    const bed = createStarfieldBed(canvas, {
      reducedMotion: prefersReducedMotion(),
      onFirstFrame: () => onFirstFrameRef.current?.()
    })
    if (!bed) {
      canvas.remove()
      onUnavailableRef.current()
      return
    }
    bedRef.current = bed
    return () => {
      bed.dispose()
      bedRef.current = null
      canvas.remove()
    }
  }, [])

  useEffect(() => {
    bedRef.current?.nudge()
  }, [pulse])

  return <div ref={wrapRef} className="onboard-starfield" aria-hidden="true" />
}
