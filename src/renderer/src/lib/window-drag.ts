import { useEffect, useRef } from 'react'

/**
 * Drag the whole overlay window from anywhere on a surface (buttons included). macOS
 * -webkit-app-region drag only catches the few empty pixels between controls, so we drive it in JS:
 * a pointer-down arms a drag, moving past an 8px dead-zone moves the window via the main process's
 * moveBy(); a stationary press still clicks the control / focuses the input underneath, and a real
 * drag swallows its trailing click so it doesn't fire the button it ended on.
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
      requestAnimationFrame(() => {
        movedRef.current = false
      })
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
      // Never arm a window-drag from inside a text field — the JS drag (unlike native -webkit-app-region)
      // ignores the CSS no-drag hint, so without this a drag-select inside the input would blur it and
      // move the window instead of selecting text. Buttons/empty surface still drag (8px dead-zone keeps
      // a click a click).
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
        return
      }
      if (e.button === 0) {
        dragRef.current = { x: e.screenX, y: e.screenY }
        movedRef.current = false
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
