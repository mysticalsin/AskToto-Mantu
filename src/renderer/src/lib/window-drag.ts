import { useEffect, useRef } from 'react'

/**
 * Drag the whole overlay window from its empty surface. macOS -webkit-app-region drag only catches the
 * few empty pixels between controls, so we widen it in JS: a pointer-down on non-interactive surface arms
 * a drag, moving past an 8px dead-zone moves the window via the main process's moveBy(); a real drag
 * swallows its trailing click so it doesn't fire whatever it ended on.
 *
 * Interactive controls (anything `.no-drag` — every button/link/slider — plus text fields) never arm a
 * drag by default: they exist to be clicked/typed in, and a click that drifts a few px must stay a
 * click. That is exactly the no-drag hint native app-region already encodes; the JS layer honours it.
 *
 * `armOnControls` inverts that for surfaces that are nearly ALL controls: the collapsed control pill is
 * a row of buttons with only slivers of padding between them, so excluding buttons left it effectively
 * undraggable. There the drag arms everywhere (text fields still excluded) and `deadZonePx` is raised so
 * a drifting click on a button still lands as a click — only a deliberate pull moves the window.
 *
 * Shared by the main widget (Bar) and the collapsed control pill (ControlPill). Pass onDragStart to
 * react to the first move (e.g. blur the text input so the caret drops while dragging).
 *
 * `noTouch` skips arming a drag for touch pointers entirely — used by the single root-level instance
 * (hoisted over the whole app, including scrollable panels) so a touchscreen drag-to-scroll gesture on
 * Windows keeps scrolling instead of moving the window. Mouse and pen are unaffected.
 */
export function useWindowDrag(
  onDragStart?: () => void,
  opts?: { armOnControls?: boolean; deadZonePx?: number; noTouch?: boolean }
): {
  onPointerDown: (e: React.PointerEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
} {
  const armOnControls = opts?.armOnControls ?? false
  const deadZonePx = opts?.deadZonePx ?? 8
  const noTouch = opts?.noTouch ?? false
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(false)
  // Coalesce pointermove -> windowMoveBy IPC: accumulate the summed delta and flush at most every ~12ms
  // instead of one IPC round-trip per pointermove (which can fire well above 60Hz on a trackpad/high-poll
  // mouse) — the window still tracks the pointer continuously, just via fewer, larger moveBy calls.
  const pendingDxRef = useRef(0)
  const pendingDyRef = useRef(0)
  const lastSendRef = useRef(0)
  // Mirror the latest onDragStart into a ref so the effect below never needs it in its dep array. Callers
  // that pass a fresh inline callback every render (easy to do by accident) would otherwise tear down and
  // re-add the window pointermove/pointerup listeners on every one of those renders; reading through a ref
  // keeps the listeners mounted once for the component's lifetime while still always invoking the latest
  // callback.
  const onDragStartRef = useRef(onDragStart)
  onDragStartRef.current = onDragStart
  // Same ref treatment for the dead-zone: the effect's listeners mount once, so they read the current
  // value through a ref rather than closing over a possibly-stale prop.
  const deadZoneRef = useRef(deadZonePx)
  deadZoneRef.current = deadZonePx

  useEffect(() => {
    const flush = (): void => {
      if (pendingDxRef.current === 0 && pendingDyRef.current === 0) return
      const dx = pendingDxRef.current
      const dy = pendingDyRef.current
      pendingDxRef.current = 0
      pendingDyRef.current = 0
      lastSendRef.current = performance.now()
      void window.toto.windowMoveBy(dx, dy)
    }
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.x
      const dy = e.screenY - dragRef.current.y
      if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < deadZoneRef.current) return
      e.preventDefault()
      if (!movedRef.current) onDragStartRef.current?.()
      movedRef.current = true
      dragRef.current = { x: e.screenX, y: e.screenY }
      pendingDxRef.current += dx
      pendingDyRef.current += dy
      if (performance.now() - lastSendRef.current >= 12) flush()
    }
    const onUp = (): void => {
      dragRef.current = null
      flush() // land any still-buffered delta so the last few px of a drag are never dropped
      // movedRef is intentionally NOT reset here. The trailing `click` still needs to see it (onClickCapture
      // swallows the click that ends a drag). It is cleared deterministically at the start of the next press
      // (onPointerDown) and by onClickCapture itself — never via rAF. An always-on-top overlay is usually
      // unfocused, and a blurred window's requestAnimationFrame is throttled/paused, so an rAF reset could
      // leave movedRef stuck true and silently swallow the NEXT real click.
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    // Deliberately no deps: onDragStart is read through onDragStartRef (see above) so the window listeners
    // are attached exactly once per mounted instance, never torn down/re-added on caller re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    onPointerDown: (e) => {
      // Start of a new gesture: clear any stale drag flag here (deterministic), never via rAF on pointerup.
      movedRef.current = false
      pendingDxRef.current = 0
      pendingDyRef.current = 0
      // Touch pointers never arm a drag here when noTouch is set — a touchscreen's scroll gesture must
      // stay a scroll, not get hijacked into moving the window.
      if (noTouch && e.pointerType === 'touch') return
      // Default: only arm a window-drag from the surface's own EMPTY space — never from an interactive
      // control or a text field. Every clickable in the widget/pill is marked `.no-drag`; honour that hint
      // here the same way native -webkit-app-region does. Arming on buttons meant a click that drifted only
      // a few px (routine on a trackpad) crossed the dead-zone, so onClickCapture silently ate it and the
      // button "wouldn't click". A control exists to be clicked or typed in: a slightly-imperfect click
      // stays a click. Button-dense surfaces (the control pill) opt into armOnControls instead — they have
      // no meaningful empty space, so buttons must arm the drag and the caller raises deadZonePx to keep
      // drifting clicks landing as clicks. Text fields never arm either way (drag-select must work).
      // `.drag` (e.g. Settings' own header) already moves the window natively via -webkit-app-region —
      // this window is frameless+transparent so that CSS property genuinely drives an OS-level drag.
      // Since the app-level instance now wraps that header too, excluding `.drag` here stops the two
      // mechanisms from BOTH firing on the same gesture and doubling every moveBy delta.
      const exclude = armOnControls
        ? 'input, textarea, [contenteditable=""], [contenteditable="true"]'
        : '.no-drag, .drag, input, textarea, [contenteditable=""], [contenteditable="true"]'
      if ((e.target as HTMLElement).closest(exclude)) {
        return
      }
      if (e.button === 0) {
        dragRef.current = { x: e.screenX, y: e.screenY }
      }
    },
    onClickCapture: (e) => {
      if (movedRef.current) {
        e.preventDefault()
        e.stopPropagation()
        movedRef.current = false
      }
    }
  }
}
