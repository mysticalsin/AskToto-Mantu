/**
 * Full-bleed KineticGrid under the exclusive tour UI after the lady+universe beat.
 * pointer-events: none. One rAF. DPR cap 2. Tiles warp; the stage does not slide.
 */
import { useEffect, useRef } from 'react'
import {
  KINETIC_CELL,
  KINETIC_COLORS,
  KINETIC_MOUSE_LERP,
  KINETIC_RIPPLE_LIFE,
  kineticPixelRatio,
  lerp2,
  rippleOffset,
  tileWarp
} from '../../lib/onboarding-kinetic-grid'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

export function KineticGrid(): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    wrap.appendChild(canvas)
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) {
      canvas.remove()
      return
    }

    const reduced = prefersReducedMotion()
    const pointer = { x: -9999, y: -9999 }
    let mouse = { x: -9999, y: -9999 }
    let cssW = 0
    let cssH = 0
    let raf = 0
    let disposed = false
    const ripples: { x: number; y: number; born: number }[] = []
    const [ar, ag, ab] = hexRgb(KINETIC_COLORS.lineActive)
    const [nr, ng, nb] = hexRgb(KINETIC_COLORS.nodeActive)

    const resize = (): void => {
      cssW = wrap.clientWidth || window.innerWidth
      cssH = wrap.clientHeight || window.innerHeight
      const dpr = kineticPixelRatio(window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const onPointerMove = (e: PointerEvent): void => {
      pointer.x = e.clientX
      pointer.y = e.clientY
    }
    const onPointerDown = (e: PointerEvent): void => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      if (!reduced) ripples.push({ x: e.clientX, y: e.clientY, born: performance.now() })
    }

    const paint = (now: number): void => {
      if (disposed) return
      if (!document.hidden) {
        mouse = lerp2(mouse, pointer, reduced ? 1 : KINETIC_MOUSE_LERP)
        ctx.fillStyle = KINETIC_COLORS.bg
        ctx.fillRect(0, 0, cssW, cssH)
        const wash = ctx.createRadialGradient(cssW * 0.5, cssH * 0.35, 40, cssW * 0.5, cssH * 0.4, Math.max(cssW, cssH) * 0.7)
        wash.addColorStop(0, KINETIC_COLORS.bgDeep)
        wash.addColorStop(1, KINETIC_COLORS.bg)
        ctx.fillStyle = wash
        ctx.fillRect(0, 0, cssW, cssH)

        const step = KINETIC_CELL
        const cols = Math.ceil(cssW / step) + 1
        const rows = Math.ceil(cssH / step) + 1
        const liveRipples = ripples.filter((r) => (now - r.born) / 1000 < KINETIC_RIPPLE_LIFE)
        ripples.length = 0
        ripples.push(...liveRipples)

        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const restX = i * step
            const restY = j * step
            const warp = reduced
              ? { dx: 0, dy: 0, falloff: 0 }
              : tileWarp({ cx: restX, cy: restY, mx: mouse.x, my: mouse.y, width: cssW, height: cssH })
            let extra = 0
            if (!reduced) {
              for (const r of liveRipples) {
                extra += rippleOffset({
                  cx: restX,
                  cy: restY,
                  ox: r.x,
                  oy: r.y,
                  ageSec: (now - r.born) / 1000
                })
              }
            }
            const x = restX + warp.dx
            const y = restY + warp.dy + extra * 0.15
            const a = 0.18 + warp.falloff * 0.72
            ctx.strokeStyle = warp.falloff > 0.04 ? `rgba(${ar},${ag},${ab},${a})` : KINETIC_COLORS.lineBase
            ctx.lineWidth = 1
            ctx.strokeRect(x + 2, y + 2, step - 6, step - 6)
            if (warp.falloff > 0.08 || extra !== 0) {
              ctx.fillStyle = `rgba(${nr},${ng},${nb},${0.18 + warp.falloff * 0.55})`
              ctx.fillRect(x + step / 2 - 1.5, y + step / 2 - 1.5, 3, 3)
            }
          }
        }
      }
      if (!document.hidden) raf = requestAnimationFrame(paint)
    }

    const onVisibility = (): void => {
      if (disposed) return
      if (document.hidden) {
        cancelAnimationFrame(raf)
        raf = 0
      } else if (!raf) {
        raf = requestAnimationFrame(paint)
      }
    }

    resize()
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', onVisibility)
    raf = requestAnimationFrame(paint)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.remove()
    }
  }, [])

  return <div ref={wrapRef} className="onboard-kinetic-grid" aria-hidden="true" />
}
