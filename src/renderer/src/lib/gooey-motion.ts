/**
 * Premium gooey micro-motion pins — docs/design/GOOEY-MOTION.md.
 * Pure: no DOM. GooeySurface and tests both import from here.
 */

export const GOOEY_PACKAGE = 'liquid-gooey'
export const GOOEY_PACKAGE_VERSION = '0.2.1'

export const GOOEY = {
  blur: 5,
  contrast: 16,
  bounce: 0.28,
  speed: 1,
  contentBlur: 0,
  pressScale: 0.96,
  ctaFill: '#f4f4f5',
  ctaMutedFill: 'rgba(244, 244, 245, 0.10)',
  waitFill: 'rgba(192, 132, 252, 0.16)',
  ctaShadow: '0 2px 16px rgba(244, 244, 245, 0.16)'
} as const

export type GooeyVariant = 'cta' | 'wait'

export function gooeyFill(variant: GooeyVariant, muted = false): string {
  if (variant === 'wait') return GOOEY.waitFill
  return muted ? GOOEY.ctaMutedFill : GOOEY.ctaFill
}

export function shouldMountGooey(opts: { reducedMotion?: boolean; hasWindow?: boolean } = {}): boolean {
  const hasWindow = opts.hasWindow ?? typeof window !== 'undefined'
  if (!hasWindow) return false
  if (opts.reducedMotion === true) return false
  return true
}
