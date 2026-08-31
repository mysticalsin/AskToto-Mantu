/**
 * Full-bleed purple constellation-grid canvas under the exclusive tour UI.
 * Mount after Next (see shouldMountConstellation). Not on hero (April 29 clip).
 * pointer-events: none. One context for the rest of the tour. Empty-deps mount.
 */
import { useEffect, useRef } from 'react'
import { createConstellationBed, type ConstellationBed } from '../lib/onboarding-constellation-engine'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function OnboardingConstellation({
  onUnavailable
}: {
  onUnavailable?: () => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const bedRef = useRef<ConstellationBed | null>(null)
  const onUnavailableRef = useRef(onUnavailable)
  onUnavailableRef.current = onUnavailable

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.opacity = '0'
    wrap.appendChild(canvas)
    let bed: ConstellationBed | null = null
    try {
      bed = createConstellationBed(canvas, { reducedMotion: prefersReducedMotion() })
    } catch {
      bed = null
    }
    if (!bed) {
      canvas.remove()
      onUnavailableRef.current?.()
      return
    }
    bedRef.current = bed
    return () => {
      try {
        bed.dispose()
      } catch {
        /* never take down Electron */
      }
      bedRef.current = null
      canvas.remove()
    }
  }, [])

  return <div ref={wrapRef} className="onboard-constellation" aria-hidden="true" />
}
