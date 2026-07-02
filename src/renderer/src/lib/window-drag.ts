import { useEffect, useRef } from 'react'

/**
 * Drag the whole overlay window from its empty surface. macOS -webkit-app-region drag only catches the
 * few empty pixels between controls, so we widen it in JS: a pointer-down on non-interactive surface arms
 * a drag, moving past an 8px dead-zone moves the window via the main process's moveBy(); a real drag
 * swallows its trailing click so it doesn't fire whatever it ended on.
 *
 * Interactive controls (anything `.no-drag` — every button/link/slider — plus text fields) never arm a
 * drag: they exist to be clicked/typed in, and a click that drifts a few px must stay a click. That is
 * exactly the no-drag hint native app-region already encodes; the JS layer honours the same one.
 *
 * Shared by the main widget (Bar) and the collapsed control pill (ControlPill). Pass onDragStart to
 * react to the first move (e.g. blur the text input so the caret drops while dragging).
 */
export function useWindowDrag(onDragStart?: () => void): {
  onPointerDown: (e: React.PointerEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
} {
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const movedRef = useRef(false)

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      if (!dragRef.current) return
      const dx = e.screenX - dragRef.current.x
      const dy = e.screenY - dragRef.current.y
      if (!movedRef.current && Math.abs(dx) + Math.abs(dy) < 8) return
      e.preventDefault()
      if (!movedRef.current) onDragStart?.()
      movedRef.current = true
      dragRef.current = { x: e.screenX, y: e.screenY }
      void window.toto.windowMoveBy(dx, dy)
    }
    const onUp = (): void => {
      dragRef.current = null
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
  }, [onDragStart])

  return {
    onPointerDown: (e) => {
      // Start of a new gesture: clear any stale drag flag here (deterministic), never via rAF on pointerup.
      movedRef.current = false
      // Only arm a window-drag from the bar's own EMPTY surface — never from an interactive control or a
      // text field. Every clickable in the widget/pill is marked `.no-drag`; honour that hint here the same
      // way native -webkit-app-region does. Arming on buttons meant a click that drifted only a few px
      // (routine on a trackpad) crossed the 8px dead-zone, so onClickCapture silently ate it and the button
      // "wouldn't click". A control exists to be clicked or typed in: a slightly-imperfect click stays a
      // click. The generous empty surface (padding, gaps between controls, the toolbar background) still drags.
      if ((e.target as HTMLElement).closest('.no-drag, input, textarea, [contenteditable=""], [contenteditable="true"]')) {
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
