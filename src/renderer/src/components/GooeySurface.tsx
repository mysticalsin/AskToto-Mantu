/**
 * Scoped liquid-gooey host for CTA pills and thinking-orb slots.
 * Pass-through under reduced-motion / no window. Never wraps the constellation bed.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Liquid } from 'liquid-gooey'
import { GOOEY, gooeyFill, shouldMountGooey, type GooeyVariant } from '../lib/gooey-motion'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
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
  const [pressed, setPressed] = useState(false)
  const reduced = prefersReducedMotion()
  const live = shouldMountGooey({ reducedMotion: reduced, hasWindow: typeof window !== 'undefined' })
  const fill = gooeyFill(variant, muted)
  const onDown = useCallback(() => setPressed(true), [])
  const onUp = useCallback(() => setPressed(false), [])

  const cls = ['gooey-surface', `gooey-surface--${variant}`, className].filter(Boolean).join(' ')

  if (!live) {
    return (
      <div className={cls} data-gooey={variant} data-gooey-live="0">
        {children}
      </div>
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
