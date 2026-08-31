/**
 * Scoped liquid-gooey host for CTA pills, thinking-orb slots, and the Act 4 selected mode card.
 * Pass-through under reduced-motion / no window / missing package. Never wraps the constellation bed.
 * Never static-imports liquid-gooey — a failed resolve must not purple-screen the tour.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { loadLiquidGooey, type LiquidComponent } from '../lib/gooey-liquid'
import { GOOEY, gooeyFill, shouldMountGooey, type GooeyVariant } from '../lib/gooey-motion'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function GooeyFallback({
  className,
  variant,
  children
}: {
  className: string
  variant: GooeyVariant
  children: ReactNode
}): JSX.Element {
  return (
    <div className={className} data-gooey={variant} data-gooey-live="0">
      {children}
    </div>
  )
}

export function GooeySurface({
  variant,
  muted = false,
  className = '',
  children
}: {
  variant: GooeyVariant
  muted?: boolean
  className?: string
  children: ReactNode
}): JSX.Element {
  const [Liquid, setLiquid] = useState<LiquidComponent | null>(null)
  const [pressed, setPressed] = useState(false)
  const reduced = prefersReducedMotion()
  const allowed = shouldMountGooey({ reducedMotion: reduced, hasWindow: typeof window !== 'undefined' })
  const fill = gooeyFill(variant, muted)
  const onDown = useCallback(() => setPressed(true), [])
  const onUp = useCallback(() => setPressed(false), [])
  const cls = ['gooey-surface', `gooey-surface--${variant}`, className].filter(Boolean).join(' ')

  useEffect(() => {
    if (!allowed) return
    let live = true
    void loadLiquidGooey().then((comp) => {
      if (live && comp) setLiquid(() => comp)
    })
    return () => {
      live = false
    }
  }, [allowed])

  if (!allowed || !Liquid) {
    return (
      <GooeyFallback className={cls} variant={variant}>
        {children}
      </GooeyFallback>
    )
  }

  return (
    <Liquid
      blur={GOOEY.blur}
      contrast={GOOEY.contrast}
      fill={fill}
      shadow={
        variant === 'cta' && !muted ? GOOEY.ctaShadow : variant === 'select' ? GOOEY.selectShadow : undefined
      }
      waviness={variant === 'wait' ? 2 : variant === 'select' ? 1 : 0}
      className={cls}
      data-gooey={variant}
      data-gooey-live="1"
      onPointerDown={variant === 'cta' ? onDown : undefined}
      onPointerUp={variant === 'cta' ? onUp : undefined}
      onPointerLeave={variant === 'cta' ? onUp : undefined}
      onPointerCancel={variant === 'cta' ? onUp : undefined}
    >
      <Liquid.Item
        scale={variant === 'cta' && pressed ? GOOEY.pressScale : 1}
        transition="bouncy"
        morph={{ shape: true, bounce: GOOEY.bounce, speed: GOOEY.speed, contentBlur: GOOEY.contentBlur }}
      >
        {children}
      </Liquid.Item>
    </Liquid>
  )
}
