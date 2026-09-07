/// <reference lib="dom" />
/**
 * Client-side zoom/pan wiring for the realtime map markup that ./map.ts's
 * renderRealtimeMapSvg already renders (the `data-map-svg` / `data-viewport` /
 * `data-pin-inner` / `data-zoom-in` / `data-zoom-out` hooks). Ported from the reference's
 * shared/ZoomPan.tsx + shared/MapCanvas.tsx (wheel-zoom-to-cursor, drag pan, +/- buttons,
 * counter-scaled pins so they stay a constant screen size through zoom).
 *
 * No DOM access anywhere at module scope — only inside the functions below — so this file
 * can be imported by the client bundler without a DOM. `attachMapInteraction` is exported
 * for the browser bundle (P1's client build pipeline wires it up); it is not unit-tested
 * here since the operator vitest config runs in a plain Node environment with no DOM.
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

export interface MapInteractionOptions {
  width: number
  height: number
  minZoom?: number
  maxZoom?: number
  /** Multiplier applied per +/- button press or keyboard +/-. Reference uses 1.6. */
  buttonZoomFactor?: number
}

export interface MapInteractionHandle {
  destroy(): void
}

/**
 * Wires wheel-zoom-to-cursor, drag pan, the +/- buttons, and keyboard +/- onto an
 * already-rendered map root (the element wrapping the `data-map-svg` / `data-map-controls`
 * markup from renderRealtimeMapSvg). Pins counter-scale via `data-pin-inner` so they stay a
 * constant screen size while the map zooms, exactly like MapCanvas.tsx.
 */
export function attachMapInteraction(root: ParentNode, options: MapInteractionOptions): MapInteractionHandle {
  const { width, height, minZoom = 1, maxZoom = 8, buttonZoomFactor = 1.6 } = options
  const svg = root.querySelector<SVGSVGElement>('[data-map-svg]')
  const viewport = root.querySelector<SVGGElement>('[data-viewport]')
  const zoomInBtn = root.querySelector<HTMLButtonElement>('[data-zoom-in]')
  const zoomOutBtn = root.querySelector<HTMLButtonElement>('[data-zoom-out]')

  let transform: Transform = { ...IDENTITY_TRANSFORM }
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

  if (svg) {
    on(svg, 'wheel', (e: Event) => {
      const we = e as WheelEvent
      we.preventDefault()
      const point = clientToSvg(we.clientX, we.clientY)
      if (!point) return
      zoomTo(point, wheelZoomFactor(transform.k, we.deltaY))
    }, { passive: false })

    let drag: { pointerId: number; startClientX: number; startClientY: number; startX: number; startY: number } | null = null

    on(svg, 'pointerdown', (e: Event) => {
      const pe = e as PointerEvent
      svg.setPointerCapture(pe.pointerId)
      drag = { pointerId: pe.pointerId, startClientX: pe.clientX, startClientY: pe.clientY, startX: transform.x, startY: transform.y }
    })
    on(svg, 'pointermove', (e: Event) => {
      const pe = e as PointerEvent
      if (!drag || drag.pointerId !== pe.pointerId) return
      const rect = svg.getBoundingClientRect()
      const dx = (pe.clientX - drag.startClientX) * (width / rect.width)
      const dy = (pe.clientY - drag.startClientY) * (height / rect.height)
      transform = clampTransform({ x: drag.startX + dx, y: drag.startY + dy, k: transform.k }, width, height, minZoom, maxZoom)
      apply()
    })
    const endDrag = (e: Event): void => {
      const pe = e as PointerEvent
      if (drag && drag.pointerId === pe.pointerId) drag = null
    }
    on(svg, 'pointerup', endDrag)
    on(svg, 'pointercancel', endDrag)

    on(svg, 'keydown', (e: Event) => {
      const ke = e as KeyboardEvent
      if (ke.key === '+' || ke.key === '=') zoomByFactor(buttonZoomFactor)
      else if (ke.key === '-' || ke.key === '_') zoomByFactor(1 / buttonZoomFactor)
    })
  }

  if (zoomInBtn) on(zoomInBtn, 'click', () => zoomByFactor(buttonZoomFactor))
  if (zoomOutBtn) on(zoomOutBtn, 'click', () => zoomByFactor(1 / buttonZoomFactor))

  apply()

  return {
    destroy(): void {
      listeners.forEach((off) => off())
    }
  }
}
