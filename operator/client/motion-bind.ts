/**
 * One entry point, `bindMotion(root)`, that scans a freshly rendered (or re-rendered) subtree
 * for the data attributes the P0.3 primitives emit and wires each one to the matching
 * operator/client/motion.ts helper. This is the only place that reads those attributes -- no
 * page should call motion.ts directly on its own markup; it renders the attribute, then calls
 * `bindMotion(theContainerThatJustChanged)` once (dev-shell's rerender() does this).
 *
 * Every attribute:
 *   data-count-to="1284"     -- countUp() to that number on first paint.
 *   data-grow                -- growBar() from the baseline (optional data-grow-delay, ms).
 *   data-stagger             -- one staggerIn() call per data-stagger-ms value found (not one
 *                                call per element: the cadence is between siblings within the
 *                                same group). data-stagger-ms is optional, default 40ms; a
 *                                section that names a different cadence (plan 6.10b: connector
 *                                rows, 30ms) sets it per row and every row in that group shares
 *                                one staggerIn() call at that speed.
 *   data-flash-key="tile-0"  -- flash() when this element's text differs from the last bind
 *                                that saw the same key (never on the very first bind: a value
 *                                is not "changed" the first time it is ever shown).
 *   data-pop                 -- pop() every bind (delta chips: "pop in after the number").
 *   data-beacon              -- beacon() -- the one allowed infinite loop.
 *
 * Reduced motion is handled inside each motion.ts helper already; bindMotion() never checks it
 * itself.
 */
import { beacon, countUp, flash, growBar, pop, staggerIn } from './motion'

const lastFlashValue = new Map<string, string>()

function toNumberAttr(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name)
  if (raw == null) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function bindMotion(root: ParentNode): void {
  root.querySelectorAll('[data-count-to]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return
    const to = Number(el.dataset.countTo)
    if (Number.isFinite(to)) countUp(el, to)
  })

  root.querySelectorAll('[data-grow]').forEach((el) => {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return
    const delay = toNumberAttr(el, 'data-grow-delay', 0)
    growBar(el, 400, delay)
  })

  const staggerEls = Array.from(root.querySelectorAll('[data-stagger]')).filter(
    (el): el is HTMLElement => el instanceof HTMLElement
  )
  if (staggerEls.length) {
    const groups = new Map<number, HTMLElement[]>()
    for (const el of staggerEls) {
      const ms = toNumberAttr(el, 'data-stagger-ms', 40)
      const group = groups.get(ms) ?? []
      group.push(el)
      groups.set(ms, group)
    }
    for (const [ms, group] of groups) staggerIn(group, ms)
  }

  root.querySelectorAll('[data-flash-key]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return
    const key = el.dataset.flashKey
    if (!key) return
    const value = el.textContent ?? ''
    const previous = lastFlashValue.get(key)
    if (previous !== undefined && previous !== value) flash(el)
    lastFlashValue.set(key, value)
  })

  root.querySelectorAll('[data-pop]').forEach((el) => {
    if (el instanceof HTMLElement) pop(el)
  })

  root.querySelectorAll('[data-beacon]').forEach((el) => {
    if (el instanceof HTMLElement) beacon(el)
  })
}
