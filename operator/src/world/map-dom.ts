/// <reference lib="dom" />
/**
 * Client-side wiring for the realtime map markup ./map.ts's renderRealtimeMapSvg renders:
 * zoom/pan (`data-map-svg` / `data-viewport` / `data-pin-inner` / `data-zoom-in` /
 * `data-zoom-out`), hover-fade + tint (`data-hover-fade` / `.world-land`), a pointer-following
 * tooltip (`data-map-tooltip`), the pulsing live beacon (`data-beacon`), and the land
 * draw-in / graticule fade-in on first mount. Ported zoom/pan from the reference's
 * shared/ZoomPan.tsx + shared/MapCanvas.tsx (wheel-zoom-to-cursor, drag pan, +/- buttons,
 * counter-scaled pins so they stay a constant screen size through zoom); hover-fade and the
 * tooltip are bklit's Choropleth Chart behaviours (plan 3.7 item 2).
 *
 * Motion goes through operator/client/motion.ts's vocabulary only (`drawPath`, `beacon`,
 * `pop`, `follow`) — no bespoke `@keyframes` here. Every animation those helpers drive already
 * collapses to an instant/static state under `prefers-reduced-motion: reduce`.
 *
 * No DOM access anywhere at module scope — only inside the functions below — so this file can
 * be imported by the client bundler without a DOM. `attachMapInteraction` is exported for the
 * browser bundle; it is not unit-tested here since the operator vitest config runs in a plain
 * Node environment with no DOM (see operator/client's own test setup for DOM-backed coverage).
 */
import { beacon, drawPath, follow, pop } from '../../client/motion'

export interface Transform {
  x: number
  y: number
  k: number
}

export const IDENTITY_TRANSFORM: Transform = { x: 0, y: 0, k: 1 }

/** Keep the viewport transform within zoom bounds and never pan past the map edges. */
export function clampTransform(t: Transform, width: number, height: number, minZoom: number, maxZoom: number): Transform {
  const k = Math.min(maxZoom, Math.max(minZoom, t.k))
  const minX = width - width * k
  const maxX = 0
  const minY = height - height * k
  const maxY = 0
  const x = Math.min(maxX, Math.max(minX, t.x))
  const y = Math.min(maxY, Math.max(minY, t.y))
  return { x, y, k }
}

/** Solve for the new x/y that keep `point` fixed on screen while zooming from prev.k to
 * nextK — the same algebra as ZoomPan.tsx's zoomToward. */
export function zoomToward(
  prev: Transform,
  point: { x: number; y: number },
  nextK: number,
  width: number,
  height: number,
  minZoom: number,
  maxZoom: number
): Transform {
  const k = Math.min(maxZoom, Math.max(minZoom, nextK))
  const contentX = (point.x - prev.x) / prev.k
  const contentY = (point.y - prev.y) / prev.k
  const x = point.x - contentX * k
  const y = point.y - contentY * k
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(k)) return prev
  return clampTransform({ x, y, k }, width, height, minZoom, maxZoom)
}

/** Wheel-delta to zoom-factor mapping, matching the reference exactly:
 * `k * exp(-deltaY * 0.002)`. */
export function wheelZoomFactor(prevK: number, deltaY: number): number {
  return prevK * Math.exp(-deltaY * 0.002)
}

export interface MapInteractionOptions {
  width: number
  height: number
  /** Plan 3.7 item 2 / Tony's reference: "wheel and drag zoom between 0.5x and 4x". */
  minZoom?: number
  maxZoom?: number
  /** Multiplier applied per +/- button press or keyboard +/-. Reference uses 1.6. */
  buttonZoomFactor?: number
  /** Milliseconds for the double-click-to-reset animation. Reference/plan: 400ms. */
  resetMs?: number
}

export interface MapInteractionHandle {
  destroy(): void
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** Country name + optional detail line for the hover tooltip, assembled from whatever
 * data-* attributes the hovered element carries — a plain `.world-land` only has a country
 * name, a `.rt-pin`/`.rt-pill` carries seats/live/asks/time-saved too, so the tooltip never
 * fabricates a number it was not given. */
function tooltipHtml(el: Element): string {
  const iso = el.getAttribute('data-iso') || ''
  const country = el.getAttribute('data-country') || ''
  const city = el.getAttribute('data-city')
  const seats = el.getAttribute('data-seats')
  const liveSeats = el.getAttribute('data-live-seats')
  const asks = el.getAttribute('data-asks')
  const timeSaved = el.getAttribute('data-time-saved')
  const places = el.getAttribute('data-places')
  const flag = iso ? `<img class="rt-tip-flag" src="/assets/flags/${iso.toLowerCase()}.svg" width="16" height="12" alt="">` : ''
  const rows: string[] = []
  if (city) rows.push(`<div class="rt-tip-title">${city}</div>`)
  else if (country) rows.push(`<div class="rt-tip-title">${country}</div>`)
  if (city && country) rows.push(`<div class="rt-tip-sub">${country}</div>`)
  if (places) rows.push(`<div class="rt-tip-row">${places} places</div>`)
  if (seats) rows.push(`<div class="rt-tip-row">${seats} seat${seats === '1' ? '' : 's'}</div>`)
  if (liveSeats) rows.push(`<div class="rt-tip-row">${liveSeats} live now</div>`)
  if (asks) rows.push(`<div class="rt-tip-row">${asks} asks · 30 min</div>`)
  if (timeSaved) rows.push(`<div class="rt-tip-row">${timeSaved} saved</div>`)
  return `<div class="rt-tip-head">${flag}${rows.shift() ?? ''}</div>${rows.join('')}`
}

/**
 * Wires wheel-zoom-to-cursor, drag pan, the +/- buttons, keyboard +/-, double-click-to-reset,
 * country hover-fade + tint, a pointer-following tooltip, the pulsing live beacon, and the
 * land draw-in / graticule fade-in onto an already-rendered map root (the element wrapping
 * the markup from renderRealtimeMapSvg). Pins counter-scale via `data-pin-inner` so they stay
 * a constant screen size while the map zooms, exactly like MapCanvas.tsx.
 */
export function attachMapInteraction(root: ParentNode, options: MapInteractionOptions): MapInteractionHandle {
  const { width, height, minZoom = 0.5, maxZoom = 4, buttonZoomFactor = 1.6, resetMs = 400 } = options
  const svg = root.querySelector<SVGSVGElement>('[data-map-svg]')
  const viewport = root.querySelector<SVGGElement>('[data-viewport]')
  const zoomInBtn = root.querySelector<HTMLButtonElement>('[data-zoom-in]')
  const zoomOutBtn = root.querySelector<HTMLButtonElement>('[data-zoom-out]')
  const tooltip = root.querySelector<HTMLElement>('[data-map-tooltip]')
  const hoverGroup = root.querySelector<SVGGElement>('[data-hover-fade]')
  const graticule = root.querySelector<SVGPathElement>('[data-graticule]')

  let transform: Transform = { ...IDENTITY_TRANSFORM }
  let resetRaf = 0
  const listeners: Array<() => void> = []

  function on(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, opts)
    listeners.push(() => target.removeEventListener(type, handler, opts))
  }

  function apply(): void {
    if (viewport) viewport.setAttribute('transform', `translate(${transform.x} ${transform.y}) scale(${transform.k})`)
    if (svg) {
      const inverse = 1 / transform.k
      svg.querySelectorAll<SVGGElement>('[data-pin-inner]').forEach((el) => {
        el.setAttribute('transform', `scale(${inverse})`)
      })
    }
  }

  function clientToSvg(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: (clientX - rect.left) * (width / rect.width),
      y: (clientY - rect.top) * (height / rect.height)
    }
  }

  function zoomTo(point: { x: number; y: number }, nextK: number): void {
    transform = zoomToward(transform, point, nextK, width, height, minZoom, maxZoom)
    apply()
  }

  function zoomByFactor(factor: number, center?: { x: number; y: number }): void {
    zoomTo(center ?? { x: width / 2, y: height / 2 }, transform.k * factor)
  }

  /** Double-click reset: animates the transform back to identity over `resetMs`, plain
   * numeric rAF easing (the same technique motion.ts's own countUp uses for a target that
   * is not a CSS-animatable property) rather than a bespoke CSS animation. Reduced motion
   * is not special-cased here — a transform reset is a one-shot state change, not a loop,
   * and jumping straight to identity is exactly what a shorter/instant version would do. */
  function resetView(): void {
    if (resetRaf) cancelAnimationFrame(resetRaf)
    const from = { ...transform }
    const start = performance.now()
    const step = (now: number): void => {
      const t = resetMs <= 0 ? 1 : Math.min(1, (now - start) / resetMs)
      const e = easeOutCubic(t)
      transform = {
        x: from.x + (IDENTITY_TRANSFORM.x - from.x) * e,
        y: from.y + (IDENTITY_TRANSFORM.y - from.y) * e,
        k: from.k + (IDENTITY_TRANSFORM.k - from.k) * e
      }
      apply()
      if (t < 1) resetRaf = requestAnimationFrame(step)
    }
    resetRaf = requestAnimationFrame(step)
  }

  // ---- hover-fade + tint (bklit): the hovered country tints, every other one fades to 40% ----
  function clearHover(): void {
    hoverGroup?.querySelectorAll('.world-land').forEach((el) => {
      el.classList.remove('is-hovered', 'is-dimmed')
    })
  }

  function setHover(target: Element): void {
    hoverGroup?.querySelectorAll('.world-land').forEach((el) => {
      if (el === target) {
        el.classList.add('is-hovered')
        el.classList.remove('is-dimmed')
      } else {
        el.classList.add('is-dimmed')
        el.classList.remove('is-hovered')
      }
    })
  }

  // ---- tooltip: follows the pointer, content set once per hovered element ----
  let hoveredEl: Element | null = null

  function showTooltipFor(el: Element, event: PointerEvent): void {
    if (!tooltip) return
    if (hoveredEl !== el) {
      tooltip.innerHTML = tooltipHtml(el)
      hoveredEl = el
    }
    tooltip.hidden = false
    follow(tooltip, event, 60)
  }

  function hideTooltip(): void {
    if (!tooltip) return
    tooltip.hidden = true
    hoveredEl = null
  }

  if (svg) {
    on(
      svg,
      'wheel',
      (e: Event) => {
        const we = e as WheelEvent
        we.preventDefault()
        const point = clientToSvg(we.clientX, we.clientY)
        if (!point) return
        zoomTo(point, wheelZoomFactor(transform.k, we.deltaY))
      },
      { passive: false }
    )

    let drag: { pointerId: number; startClientX: number; startClientY: number; startX: number; startY: number; moved: boolean } | null = null

    on(svg, 'pointerdown', (e: Event) => {
      const pe = e as PointerEvent
      svg.setPointerCapture(pe.pointerId)
      drag = { pointerId: pe.pointerId, startClientX: pe.clientX, startClientY: pe.clientY, startX: transform.x, startY: transform.y, moved: false }
    })
    on(svg, 'pointermove', (e: Event) => {
      const pe = e as PointerEvent
      if (drag && drag.pointerId === pe.pointerId) {
        const rect = svg.getBoundingClientRect()
        const dx = (pe.clientX - drag.startClientX) * (width / rect.width)
        const dy = (pe.clientY - drag.startClientY) * (height / rect.height)
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true
        transform = clampTransform({ x: drag.startX + dx, y: drag.startY + dy, k: transform.k }, width, height, minZoom, maxZoom)
        apply()
      }
      const hit = (pe.target as Element | null)?.closest('.world-land, .rt-pin, .rt-pill')
      if (hit) {
        if (hit !== hoveredEl && hit.classList.contains('world-land')) setHover(hit)
        else if (!hit.classList.contains('world-land')) clearHover()
        showTooltipFor(hit, pe)
      } else {
        clearHover()
        hideTooltip()
      }
    })
    const endDrag = (e: Event): void => {
      const pe = e as PointerEvent
      if (drag && drag.pointerId === pe.pointerId) drag = null
    }
    on(svg, 'pointerup', endDrag)
    on(svg, 'pointercancel', endDrag)
    on(svg, 'pointerleave', () => {
      clearHover()
      hideTooltip()
    })

    on(svg, 'dblclick', (e: Event) => {
      e.preventDefault()
      resetView()
    })

    on(svg, 'keydown', (e: Event) => {
      const ke = e as KeyboardEvent
      if (ke.key === '+' || ke.key === '=') zoomByFactor(buttonZoomFactor)
      else if (ke.key === '-' || ke.key === '_') zoomByFactor(1 / buttonZoomFactor)
      else if (ke.key === '0') resetView()
    })
  }

  if (zoomInBtn) on(zoomInBtn, 'click', () => zoomByFactor(buttonZoomFactor))
  if (zoomOutBtn) on(zoomOutBtn, 'click', () => zoomByFactor(1 / buttonZoomFactor))

  apply()

  // ---- first-paint motion: land draws in over 800ms, graticule fades in after,
  // the live beacon pulses, pins/pills pop in (plan 3.5b) ----
  root.querySelectorAll<SVGPathElement>('.world-land').forEach((p) => drawPath(p, 800))
  if (graticule) {
    graticule.classList.add('is-hidden')
    setTimeout(() => graticule.classList.remove('is-hidden'), 800)
  }
  root.querySelectorAll<SVGCircleElement>('[data-beacon]').forEach((el) => beacon(el as unknown as HTMLElement))
  root.querySelectorAll<SVGGElement>('.rt-pin, .rt-pill').forEach((el) => pop(el as unknown as HTMLElement))

  return {
    destroy(): void {
      if (resetRaf) cancelAnimationFrame(resetRaf)
      listeners.forEach((off) => off())
    }
  }
}
