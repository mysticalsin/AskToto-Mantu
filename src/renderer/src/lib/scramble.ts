/**
 * Act 1 (Welcome) wordmark reveal — pure scramble/reveal logic for the "Métis" wordmark that resolves
 * out of scrambled glyphs on the onboarding hero scene (see OnboardingExperience.tsx). Kept dependency-
 * and DOM-free on purpose, per MQA-276: the whole point of extracting it is that `scrambleFrame` is
 * testable in the plain node vitest environment this repo runs (no jsdom/happy-dom anywhere in the
 * suite — see vitest.config.ts), the same way `overlay-autohide.ts`'s reducer is tested away from React.
 * `useScrambleReveal` below is the only DOM/rAF-touching part, and it is intentionally thin: a bug there
 * is a wiring bug, not a logic bug.
 */
import { useEffect, useState } from 'react'

const DEFAULT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export interface ScrambleOptions {
  /** Pool of filler glyphs shown for not-yet-resolved characters. */
  charset?: string
  /** Injectable RNG so callers/tests get deterministic scrambles. Defaults to Math.random. */
  random?: () => number
}

/**
 * Renders `target` as it should look at animation `progress` (0 = fully scrambled, 1 = fully resolved).
 * Each character locks in once `progress` crosses its own threshold `(index + 1) / length` — so the word
 * appears to decrypt itself left-to-right rather than every glyph settling at once, and calling this
 * again and again with the SAME progress but a fresh `random()` draw is what produces the flicker (the
 * caller drives that; this function is a pure per-frame projection, not a stateful animator).
 *
 * Whitespace is never scrambled, so multi-word targets keep their legible shape throughout. `progress`
 * is clamped internally so a raw `elapsed / duration` ratio can be passed straight through without the
 * caller guarding overshoot on the final frame.
 */
export function scrambleFrame(target: string, progress: number, options: ScrambleOptions = {}): string {
  const { charset = DEFAULT_CHARSET, random = Math.random } = options
  const length = target.length
  if (length === 0 || charset.length === 0) return target
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress

  let out = ''
  for (let i = 0; i < length; i++) {
    const char = target[i]
    if (/\s/.test(char)) {
      out += char
      continue
    }
    const resolvesAt = (i + 1) / length
    out += p >= resolvesAt ? char : charset[Math.floor(random() * charset.length)]
  }
  return out
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * rAF-driven reveal: resolves `target` from scrambled glyphs to plain text over `durationMs`. Honors the
 * OS-level reduced-motion preference by never starting the animation loop at all — it returns the fully
 * resolved target immediately — matching the product's honesty rule for onboarding motion (a static
 * resolved state, never a scramble stuck mid-flicker for someone who asked the OS to reduce motion).
 */
export function useScrambleReveal(target: string, durationMs = 900): string {
  const [text, setText] = useState<string>(() => (prefersReducedMotion() ? target : scrambleFrame(target, 0)))

  useEffect(() => {
    if (prefersReducedMotion()) {
      setText(target)
      return
    }
    let frame = 0
    let cancelled = false
    const start = performance.now()
    const tick = (now: number): void => {
      if (cancelled) return
      const progress = (now - start) / durationMs
      setText(scrambleFrame(target, progress))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [target, durationMs])

  return text
}
