/**
 * Motion vocabulary (plan 3.5, 3.5b -- MOTION_INTENSITY 7, a hard per-section gate). Vanilla
 * `motion/mini` (WAAPI-backed, no JS animation engine), so the client bundle only pays for
 * `animate()` itself, not the full framer-motion runtime. Every export here is a helper only:
 * nothing in this file is wired into a page yet (P0.1 scope ends at exporting these functions).
 * A later task calls them from render/client page code.
 *
 * Full vocabulary: `countUp`, `flash`, `staggerIn`, `press`, `slideIn`, `shimmer`, `beacon`
 * (plan 3.5) plus `drawPath`, `flip`, `growBar`, `pop`, `follow`, `sequence` (plan 3.5b). No
 * page should write its own keyframes outside this file or the shared CSS classes in
 * operator/src/spa/css.ts.
 *
 * Gate (plan 3.5): `prefers-reduced-motion: reduce` collapses every animation below to an
 * instant state set, opacity only where a change must still be visible. `reduceMotion()` is
 * checked once at module load and re-checked on change, matching the spec's "checked once,
 * re-checked on change" -- callers do not need to re-query matchMedia themselves.
 *
 * Easing values mirror operator/src/spa/css.ts's `--ease-spring` and `--ease-color` tokens
 * (plan 3.5) as cubic-bezier point arrays, the shape motion/mini's `easing` option accepts.
 */
import { animate } from 'motion/mini'

/** cubic-bezier(.23,1,.32,1) -- transform/layout, 200-350ms (css.ts --ease-spring). */
const EASE_SPRING: [number, number, number, number] = [0.23, 1, 0.32, 1]
/** cubic-bezier(.32,.72,0,1) -- colour, 150ms (css.ts --ease-color). */
const EASE_COLOR: [number, number, number, number] = [0.32, 0.72, 0, 1]

let reduced = false

function readReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

try {
  reduced = readReducedMotion()
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
  const onChange = (): void => {
    reduced = mq.matches
  }
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
} catch {
  /* no matchMedia (non-browser test context): stay with the default, motion enabled */
}

let override: boolean | null = null

/** Current reduced-motion preference: an explicit override (Settings > Appearance > "Reduced
 *  motion", plan 6.11) wins when set, otherwise the OS/browser preference, re-evaluated on
 *  every change, not just once. */
export function reduceMotion(): boolean {
  return override ?? reduced
}

/** Sets an explicit override ahead of the OS/browser preference (`true` forces reduced motion,
 *  `false` forces motion on, `null` goes back to following the OS/browser). Backs the plan
 *  6.11 Settings > Appearance "Follow system / Reduce" control; also what
 *  operator/scripts/preview-motion.mjs's "Reduce motion" checkbox flips live. */
export function setReducedMotionOverride(value: boolean | null): void {
  override = value
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Count-up on a KPI numeral, 800ms, meant for first render only (plan 3.5: "the numbers are
 * the page"). Drives the element's text content directly with rAF rather than motion/mini,
 * since animating displayed digits is not a CSS-animatable property. Reduced motion: the final
 * value is set instantly, no interpolation.
 */
export function countUp(
  el: HTMLElement,
  to: number,
  opts: { duration?: number; format?: (n: number) => string; from?: number } = {}
): void {
  const format = opts.format ?? ((n: number) => Math.round(n).toLocaleString('en-US'))
  const from = opts.from ?? 0
  if (reduceMotion()) {
    el.textContent = format(to)
    return
  }
  const duration = opts.duration ?? 800
  const start = performance.now()
  function tick(now: number): void {
    const elapsed = now - start
    const progress = duration <= 0 ? 1 : Math.min(1, elapsed / duration)
    const value = from + (to - from) * easeOutCubic(progress)
    el.textContent = format(value)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/**
 * Value flash: an --accent-soft wash that fades out over 600ms (plan 3.5), for any number that
 * changed during a live refresh. Reduced motion: no-op -- the new value is already visible as
 * text, the wash itself carries no information beyond emphasis.
 */
export function flash(el: HTMLElement): void {
  if (reduceMotion()) return
  animate(
    el,
    { backgroundColor: ['color-mix(in srgb, var(--accent-soft) 100%, transparent)', 'transparent'] },
    { duration: 0.6, ease: EASE_COLOR }
  )
}

/**
 * Stagger-in: 40ms per row (plan 3.5), for rows that arrive from a live refresh or a "load
 * older" page. Reduced motion: every row's opacity is set to 1 instantly, no delay, no
 * transform -- a batch still "arrives" but without motion.
 */
export function staggerIn(els: ArrayLike<HTMLElement>): void {
  const list = Array.from(els)
  if (reduceMotion()) {
    for (const el of list) el.style.opacity = '1'
    return
  }
  list.forEach((el, i) => {
    animate(
      el,
      { opacity: [0, 1], transform: ['translateY(4px)', 'translateY(0)'] },
      { duration: 0.3, delay: i * 0.04, ease: EASE_SPRING }
    )
  })
}

/**
 * Spring press: scale(.97) feedback on a button or row tap (plan 3.5). Binds pointerdown /
 * pointerup / pointercancel / pointerleave once; returns an unbind function. Reduced motion:
 * does not bind at all -- click feedback stays whatever the browser/CSS `:active` state gives.
 */
export function press(el: HTMLElement): () => void {
  if (reduceMotion()) return () => {}
  const down = (): void => {
    animate(el, { transform: ['scale(1)', 'scale(0.97)'] }, { duration: 0.12, ease: EASE_SPRING })
  }
  const up = (): void => {
    animate(el, { transform: ['scale(0.97)', 'scale(1)'] }, { duration: 0.18, ease: EASE_SPRING })
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('pointerleave', up)
  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('pointerleave', up)
  }
}

export type SlideInFrom = 'right' | 'left' | 'top' | 'bottom'

const SLIDE_OFFSET: Record<SlideInFrom, string> = {
  right: 'translateX(24px)',
  left: 'translateX(-24px)',
  top: 'translateY(-24px)',
  bottom: 'translateY(24px)'
}

/**
 * Drawer slide-in from an edge with spring easing plus a fade (plan 3.5: state change). Reduced
 * motion: the drawer is shown at its resting position and full opacity instantly.
 */
export function slideIn(el: HTMLElement, from: SlideInFrom = 'right'): void {
  if (reduceMotion()) {
    el.style.opacity = '1'
    el.style.transform = 'none'
    return
  }
  animate(
    el,
    { opacity: [0, 1], transform: [SLIDE_OFFSET[from], 'translate(0, 0)'] },
    { duration: 0.28, ease: EASE_SPRING }
  )
}

const SHIMMER_CLASS = 'is-shimmering'

/**
 * Skeleton shimmer while a JSON fetch is in flight (plan 3.5: loading). Toggles a class; the
 * actual `@keyframes` lives in operator/src/spa/css.ts's `.skeleton-row` rule, which already
 * sits under the stylesheet's global `prefers-reduced-motion: reduce` override, so this helper
 * only needs to stop *adding* the class under reduced motion, never fight the CSS.
 */
export function shimmer(el: HTMLElement, on: boolean): void {
  if (!on) {
    el.classList.remove(SHIMMER_CLASS)
    return
  }
  if (reduceMotion()) return
  el.classList.add(SHIMMER_CLASS)
}

let beaconKeyframesInstalled = false

/** One `<style>` tag, installed once, for the infinite beacon halo (plan 3.5: "the only
 *  infinite loops on the page"). Kept out of css.ts because it is purely a motion detail, not a
 *  layout or token rule, and only ever needed once a beacon actually renders. */
function ensureBeaconKeyframes(): void {
  if (beaconKeyframesInstalled) return
  beaconKeyframesInstalled = true
  const style = document.createElement('style')
  style.textContent =
    '@keyframes metis-beacon-halo{0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--live) 55%, transparent)}100%{box-shadow:0 0 0 14px color-mix(in srgb, var(--live) 0%, transparent)}}'
  document.head.appendChild(style)
}

/**
 * Beacon pulse: a 2.4s halo on live seats on the map and the rail's live dot (plan 3.5). The
 * only motion allowed to loop forever. Reduced motion: the beacon stays a plain, static dot --
 * still "live", just not animated.
 */
export function beacon(el: HTMLElement): void {
  if (reduceMotion()) return
  ensureBeaconKeyframes()
  el.style.animation = 'metis-beacon-halo 2.4s cubic-bezier(0.32, 0.72, 0, 1) infinite'
}

/**
 * Path draw-in: stroke-dashoffset from full length to 0 (plan 3.5b: map land, area charts,
 * session timeline lines). `ms` defaults to 800 (the plan's first-paint draw duration). Reduced
 * motion: the dash properties are cleared so the path renders fully drawn immediately.
 */
export function drawPath(svgPath: SVGPathElement, ms = 800): void {
  const length = svgPath.getTotalLength()
  if (reduceMotion()) {
    svgPath.style.strokeDasharray = ''
    svgPath.style.strokeDashoffset = ''
    return
  }
  svgPath.style.strokeDasharray = String(length)
  svgPath.style.strokeDashoffset = String(length)
  animate(svgPath, { strokeDashoffset: [length, 0] }, { duration: ms / 1000, ease: EASE_SPRING })
}

/**
 * FLIP reorder/insert (plan 3.5b: live event feeds, "load older", table row inserts). Measures
 * every child of `container` (First), runs `mutate` (which adds/removes/reorders children,
 * Last), then plays each surviving child from its old position to its new one (Invert + Play,
 * spring easing) and fades+rises newly inserted children in, staggered 40ms apart when more
 * than one is new in the same call (plan 3.5b: "table rows stagger in ... on 'Load older'").
 * Reduced motion: `mutate` still runs (the DOM must update either way) but nothing animates --
 * children land at rest instantly.
 */
export function flip(container: HTMLElement, mutate: () => void): void {
  const before = new Map<Element, DOMRect>()
  for (const el of Array.from(container.children)) before.set(el, el.getBoundingClientRect())
  mutate()
  if (reduceMotion()) return
  let newIndex = 0
  for (const el of Array.from(container.children)) {
    if (!(el instanceof HTMLElement)) continue
    const prev = before.get(el)
    if (!prev) {
      animate(
        el,
        { opacity: [0, 1], transform: ['translateY(4px)', 'translateY(0)'] },
        { duration: 0.3, delay: newIndex * 0.04, ease: EASE_SPRING }
      )
      newIndex++
      continue
    }
    const last = el.getBoundingClientRect()
    const dx = prev.left - last.left
    const dy = prev.top - last.top
    if (dx === 0 && dy === 0) continue
    animate(el, { transform: [`translate(${dx}px, ${dy}px)`, 'translate(0, 0)'] }, { duration: 0.32, ease: EASE_SPRING })
  }
}

/**
 * Grow a bar from its baseline via `transform: scale{X,Y}` (plan 3.5b: mini bars, full-row
 * table bars, usage bars). Orientation is inferred from the element's own box: taller than wide
 * grows from the bottom (scaleY), wider than tall grows from the left (scaleX) -- callers never
 * need to say which axis their bar uses. `delay` is in ms, matching the per-bar stagger the plan
 * asks for (e.g. 20ms per mini bar). Reduced motion: the bar is shown at full size, no growth.
 * Accepts an SVG element too (visitorsBars()' `<rect>` bars): `transform` and
 * `getBoundingClientRect()` work the same way there.
 */
export function growBar(el: HTMLElement | SVGElement, ms = 400, delay = 0): void {
  if (reduceMotion()) {
    el.style.transform = 'none'
    return
  }
  const rect = el.getBoundingClientRect()
  const vertical = rect.height >= rect.width
  el.style.transformOrigin = vertical ? 'bottom' : 'left'
  const axis = vertical ? 'scaleY' : 'scaleX'
  animate(el, { transform: [`${axis}(0)`, `${axis}(1)`] }, { duration: ms / 1000, delay: delay / 1000, ease: EASE_SPRING })
}

/**
 * Pop: scale(.8) to scale(1) with a fade-in, spring easing (plan 3.5b: delta chips, tier
 * badges, city dots). One-shot entrance, not a loop. Reduced motion: the element is shown at
 * full scale and opacity instantly.
 */
export function pop(el: HTMLElement): void {
  if (reduceMotion()) {
    el.style.opacity = '1'
    el.style.transform = 'none'
    return
  }
  animate(el, { transform: ['scale(0.8)', 'scale(1)'], opacity: [0, 1] }, { duration: 0.28, ease: EASE_SPRING })
}

/**
 * Follow: moves `el` to the pointer with a short spring lag (plan 3.5b: map country tooltip).
 * Call this from a `pointermove` handler on every event; each call animates from wherever `el`
 * currently is toward the new pointer position over `lagMs`, so a fast-moving pointer leaves the
 * element trailing slightly instead of teleporting -- that trail is the "lag". `el` is expected
 * to be positioned (`position: fixed` or `absolute`, `left: 0; top: 0`) so the translate lands
 * at the viewport coordinate directly. Reduced motion: `el` jumps straight to the pointer, no
 * trailing.
 */
export function follow(el: HTMLElement, pointerEvent: { clientX: number; clientY: number }, lagMs = 60): void {
  const target = `translate(${pointerEvent.clientX}px, ${pointerEvent.clientY}px)`
  if (reduceMotion()) {
    el.style.transform = target
    return
  }
  animate(el, { transform: [target] }, { duration: lagMs / 1000, ease: EASE_SPRING })
}

export interface SequenceStep {
  /** Runs the step (typically calling one of the helpers above on one element). */
  run: () => void
  /** Delay before this step, in ms, added to every prior step's delay (plan 3.5b: "stagger
   *  30ms", "stagger 40ms" reveals that are not a flat list of same-shaped rows, so `staggerIn`
   *  does not fit -- an ask trace revealing field by field, a timeline popping in one event at a
   *  time). */
  delayMs?: number
}

/**
 * Runs a list of steps with cumulative delays (plan 3.5b: "a tiny sequence([...]) helper for
 * staggered reveals"). Reduced motion: every step runs immediately, in order, no delay --
 * each step's own reduce-motion handling (if it calls another helper here) still applies.
 */
export function sequence(steps: SequenceStep[]): void {
  let elapsed = 0
  for (const step of steps) {
    elapsed += step.delayMs ?? 0
    if (reduceMotion() || elapsed <= 0) {
      step.run()
    } else {
      setTimeout(step.run, elapsed)
    }
  }
}
