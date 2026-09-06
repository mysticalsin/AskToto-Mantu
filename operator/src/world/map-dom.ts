/// <reference lib="dom" />
/**
 * Client-side interaction wiring for the realtime map markup that ./map.ts's
 * renderRealtimeMapSvg already renders (the `data-map-svg` / `data-viewport` / `data-pin-inner`
 * / `data-zoom-in` / `data-zoom-out` / `data-iso` / `data-country-pill` hooks). Ported from the
 * reference's shared/ZoomPan.tsx + shared/MapCanvas.tsx (wheel-zoom-to-cursor, drag pan, +/-
 * buttons, counter-scaled pins so they stay a constant screen size through zoom) and extended
 * per plan 3.7 item 2 / 6.3 with bklit's choropleth behaviours: hover fades every other country
 * to 40% and tints the hovered one, a country click (land, pill, or dot) reports up through
 * `onCountryClick` for the page to filter its Geo table and set a toolbar chip, and a double
 * click resets the view.
 *
 * No DOM access anywhere at module scope — only inside the functions below — so this file can
 * be imported by the client bundler without a DOM. `attachMapInteraction` is exported for the
 * browser bundle; it is not unit-tested here since the operator vitest config runs in a plain
 * Node environment with no DOM (the pure math it delegates to -- clampTransform, zoomToward,
 * wheelZoomFactor -- is fully covered by map.test.ts-style unit tests already).
 */

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

/** What one hovered/clicked country carries in its `data-*` attributes (rendered once by
 * ./map.ts on the land path, the pin, and the pill, so any of the three can be hovered or
 * clicked interchangeably and produce the exact same tooltip/filter). */
export interface CountryHit {
  iso: string
  country: string
  seats: number | null
  live: number | null
  places: number | null
}

export interface MapInteractionOptions {
  width: number
  height: number
  /** Plan 3.7 item 2: "wheel and drag zoom 0.5x to 4x". */
  minZoom?: number
  maxZoom?: number
  /** Multiplier applied per +/- button press or keyboard +/-. Reference uses 1.6. */
  buttonZoomFactor?: number
  /** Fires on every pointer move over the map (hovering or not) with the raw client
   * coordinates, so the caller can keep a following tooltip positioned (plan 3.7 item 2:
   * "a tooltip follows the mouse"). Never fired while a drag is in progress. */
  onPointerMove?: (clientX: number, clientY: number) => void
  /** Fires when the hovered country changes (land, pin, or pill), or with `null` when the
   * pointer leaves every country. This module already fades every other country to 40% and
   * tints the hovered one; the caller only needs this to fill in the tooltip's text. */
  onHoverChange?: (hit: CountryHit | null) => void
  /** Fires on a genuine click/tap (pointer moved less than a few px between down and up) on a
   * country's land, pin, or pill, or with `null` on a click that hit neither (clearing any
   * active filter). Toggling behaviour (click the same country again to clear) is the caller's,
   * since only the caller knows the current filter state. */
  onCountryClick?: (hit: CountryHit | null) => void
}

export interface MapInteractionHandle {
  destroy(): void
}

const DRAG_CLICK_THRESHOLD_PX = 4
const RESET_DURATION_MS = 420

function numAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name)
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Reads the hovered/clicked country off whichever of the three elements map.ts renders
 * carries the hit (a land path, a dot, or the pill) -- all three carry the same `data-iso` /
 * `data-country`, but only the pill carries the country-wide `data-country-seats` / `-live` /
 * `-places` aggregate, so a land or dot hit looks its pill up by iso for those. */
function readCountryHit(el: Element | null): CountryHit | null {
  const host = el?.closest<HTMLElement | SVGElement>('[data-iso], [data-pin]')
  if (!host) return null
  const iso = host.getAttribute('data-iso')
  const country = host.getAttribute('data-country')
  if (!iso || !country) return null
  const pill = host.hasAttribute('data-country-pill')
    ? host
    : (host.closest('svg') ?? host.ownerDocument)?.querySelector(`[data-country-pill][data-iso="${iso}"]`)
  return {
    iso,
    country,
    seats: pill ? numAttr(pill, 'data-country-seats') : null,
    live: pill ? numAttr(pill, 'data-country-live') : null,
    places: pill ? numAttr(pill, 'data-country-places') : null
  }
}

/**
 * Wires wheel-zoom-to-cursor, drag pan, the +/- buttons, keyboard +/-, double-click reset,
 * country hover (fade/tint) and country click onto an already-rendered map root (the element
 * wrapping the `data-map-svg` / `data-map-controls` markup from renderRealtimeMapSvg). Pins
 * counter-scale via `data-pin-inner` so they stay a constant screen size through zoom, exactly
 * like MapCanvas.tsx.
 */
export function attachMapInteraction(root: ParentNode, options: MapInteractionOptions): MapInteractionHandle {
  const { width, height, minZoom = 0.5, maxZoom = 4, buttonZoomFactor = 1.6, onPointerMove, onHoverChange, onCountryClick } = options
  const svg = root.querySelector<SVGSVGElement>('[data-map-svg]')
  const viewport = root.querySelector<SVGGElement>('[data-viewport]')
  const graticule = root.querySelector<SVGGElement>('[data-graticule]')
  const zoomInBtn = root.querySelector<HTMLButtonElement>('[data-zoom-in]')
  const zoomOutBtn = root.querySelector<HTMLButtonElement>('[data-zoom-out]')

  let transform: Transform = { ...IDENTITY_TRANSFORM }
  let hoveredIso: string | null = null
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

  function reset(): void {
    if (viewport) {
      viewport.classList.add('is-resetting')
      setTimeout(() => viewport.classList.remove('is-resetting'), RESET_DURATION_MS)
    }
    transform = { ...IDENTITY_TRANSFORM }
    apply()
  }

  // -- Hover: fade every other country to 40%, tint the hovered one (plan 3.7 item 2). Applied
  // to every element sharing the hovered iso (a country can be several disjoint land pieces)
  // plus its pill; every non-matching land path and pill fades. --
  function setHover(hit: CountryHit | null): void {
    const iso = hit?.iso ?? null
    if (iso === hoveredIso) return
    hoveredIso = iso
    if (svg) {
      svg.querySelectorAll<SVGElement>('.world-land').forEach((el) => {
        const match = el.getAttribute('data-iso') === iso
        el.classList.toggle('is-hovered', Boolean(iso) && match)
        el.classList.toggle('is-faded', Boolean(iso) && !match)
      })
      svg.querySelectorAll<SVGElement>('[data-country-pill], .rt-pin').forEach((el) => {
        const match = el.getAttribute('data-iso') === iso
        el.classList.toggle('is-faded', Boolean(iso) && !match)
      })
    }
    onHoverChange?.(hit)
  }

  if (svg) {
    on(svg, 'wheel', (e: Event) => {
      const we = e as WheelEvent
      we.preventDefault()
      const point = clientToSvg(we.clientX, we.clientY)
      if (!point) return
      zoomTo(point, wheelZoomFactor(transform.k, we.deltaY))
    }, { passive: false })

    let drag: {
      pointerId: number
      startClientX: number
      startClientY: number
      startX: number
      startY: number
      moved: boolean
      hit: CountryHit | null
    } | null = null

    on(svg, 'pointerdown', (e: Event) => {
      const pe = e as PointerEvent
      svg.setPointerCapture(pe.pointerId)
      drag = {
        pointerId: pe.pointerId,
        startClientX: pe.clientX,
        startClientY: pe.clientY,
        startX: transform.x,
        startY: transform.y,
        moved: false,
        hit: readCountryHit(pe.target as Element | null)
      }
    })
    on(svg, 'pointermove', (e: Event) => {
      const pe = e as PointerEvent
      onPointerMove?.(pe.clientX, pe.clientY)
      if (!drag || drag.pointerId !== pe.pointerId) {
        if (!drag) setHover(readCountryHit(pe.target as Element | null))
        return
      }
      const rect = svg.getBoundingClientRect()
      const dx = (pe.clientX - drag.startClientX) * (width / rect.width)
      const dy = (pe.clientY - drag.startClientY) * (height / rect.height)
      if (Math.abs(pe.clientX - drag.startClientX) > DRAG_CLICK_THRESHOLD_PX || Math.abs(pe.clientY - drag.startClientY) > DRAG_CLICK_THRESHOLD_PX) {
        drag.moved = true
      }
      transform = clampTransform({ x: drag.startX + dx, y: drag.startY + dy, k: transform.k }, width, height, minZoom, maxZoom)
      apply()
    })
    const endDrag = (e: Event): void => {
      const pe = e as PointerEvent
      if (!drag || drag.pointerId !== pe.pointerId) return
      if (!drag.moved) onCountryClick?.(drag.hit)
      drag = null
    }
    on(svg, 'pointerup', endDrag)
    on(svg, 'pointercancel', endDrag)
    on(svg, 'pointerleave', () => setHover(null))
    on(svg, 'blur', () => setHover(null))
    on(svg, 'dblclick', (e: Event) => {
      e.preventDefault()
      reset()
    })

    on(svg, 'keydown', (e: Event) => {
      const ke = e as KeyboardEvent
      if (ke.key === '+' || ke.key === '=') zoomByFactor(buttonZoomFactor)
      else if (ke.key === '-' || ke.key === '_') zoomByFactor(1 / buttonZoomFactor)
      else if (ke.key === '0') reset()
    })
  }

  if (zoomInBtn) on(zoomInBtn, 'click', () => zoomByFactor(buttonZoomFactor))
  if (zoomOutBtn) on(zoomOutBtn, 'click', () => zoomByFactor(1 / buttonZoomFactor))

  // Reveal the graticule shortly after first paint, once the land's own draw-in has had time
  // to read (plan 3.5b: "graticule fades in after"). The caller's own first-paint sequence
  // (initRealtime) drives the land's drawPath(); this only needs to be a fixed, generous delay
  // since the graticule is a background layer, not something worth precisely chaining.
  if (graticule) setTimeout(() => graticule.classList.add('is-shown'), 900)

  apply()

  return {
    destroy(): void {
      listeners.forEach((off) => off())
    }
  }
}
