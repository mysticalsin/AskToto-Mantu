/**
 * Full-bleed Starfield Close canvas under the exclusive tour UI.
 * Mount only after Next/Start (see shouldMountStarfield). pointer-events: none.
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
  onUnavailable
}: {
  pulse: number
  onUnavailable: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const bedRef = useRef<StarfieldBed | null>(null)
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    wrap.appendChild(canvas)
    const bed = createStarfieldBed(canvas, { reducedMotion: prefersReducedMotion() })
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
