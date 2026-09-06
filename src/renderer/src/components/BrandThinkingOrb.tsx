import { useEffect, useRef, type CanvasHTMLAttributes } from 'react'
import { MODE_DRAWS, resolvePreset, type OrbState, type OrbTheme } from 'thinking-orbs'

/**
 * Jakub thinking-orb for the Métis Bar / Settings Circle.
 * Always animates: Windows Show animations off maps to OS reduce media query
 * and the stock ThinkingOrb freezes to one frame — that killed the product identity.
 * Still pauses when the document is hidden or the host is off-screen.
 */
export function BrandThinkingOrb({
  state = 'solving',
  size = 64,
  theme = 'dark',
  speed = 1,
  animate = true,
  className,
  ...rest
}: {
  state?: OrbState
  size?: 64 | 20
  theme?: OrbTheme
  speed?: number
  /** Settings picker: only the selected card keeps a live rAF. */
  animate?: boolean
  className?: string
} & Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'style'>): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  const dark = theme !== 'light'

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, typeof devicePixelRatio !== 'undefined' ? devicePixelRatio || 1 : 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { mode, speed: presetSpeed, opts } = resolvePreset(state, size)
    const draw = MODE_DRAWS[mode]
    const rate = presetSpeed * speed
    const paint = (t: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)
      draw(ctx, size, t, dark, opts)
    }
    let raf = 0
    let running = false
    const stop = (): void => {
      running = false
      cancelAnimationFrame(raf)
    }
    const start = (): void => {
      if (running) return
      if (document.visibilityState === 'hidden') return
      running = true
      const loop = (): void => {
        paint((performance.now() / 1000) * rate)
        if (running) raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
    }
    paint((performance.now() / 1000) * rate)
    if (!animate) {
      return () => undefined
    }
    let onScreen = true
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting
            if (onScreen && document.visibilityState !== 'hidden') start()
            else stop()
          })
        : null
    io?.observe(canvas)
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') stop()
      else if (onScreen) start()
    }
    document.addEventListener('visibilitychange', onVis)
    if (!io) start()
    return () => {
      stop()
      io?.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [state, size, dark, speed, animate])

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      style={{ width: size, height: size, display: 'block' }}
      {...rest}
    />
  )
}
