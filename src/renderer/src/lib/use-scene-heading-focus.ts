import { useEffect, useRef, type RefObject } from 'react'

/**
 * Each onboarding scene is a different element tree, so the focused control unmounts on every step.
 * After a scene change, move focus to the new scene's heading (or the element marked
 * `data-onboard-focus`) so keyboard users keep their place and a screen reader announces the scene.
 * The target gets tabindex -1 (focusable by script only, never a tab stop). The first mount is
 * skipped: the hero keeps the document's natural starting point.
 */
export function useSceneHeadingFocus<T extends HTMLElement>(scene: string): RefObject<T> {
  const slotRef = useRef<T>(null)
  const readyRef = useRef(false)
  useEffect(() => {
    if (!readyRef.current) {
      readyRef.current = true
      return
    }
    const target = slotRef.current?.querySelector<HTMLElement>('[data-onboard-focus], h1, h2')
    if (!target) return
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus({ preventScroll: true })
  }, [scene])
  return slotRef
}
