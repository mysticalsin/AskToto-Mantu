import { type Transition } from 'motion/react'
import { useReducedMotion } from 'motion/react'

/** Apple-grade spring: short, damped, compositor-class. */
export const INTEL_SPRING: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 32,
  mass: 0.85
}

export const INTEL_SPRING_SOFT: Transition = {
  type: 'spring',
  stiffness: 320,
  damping: 34,
  mass: 0.9
}

/** Cap stagger so a long list never waits seconds to appear. */
export function intelStagger(index: number, step = 0.032, cap = 10): number {
  return Math.min(index, cap) * step
}

export function useIntelReducedMotion(): boolean {
  return !!useReducedMotion()
}
