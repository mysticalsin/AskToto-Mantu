import { useEffect, useRef, type MutableRefObject } from 'react'
import type { RendererView } from '@shared/renderer-view'
import { isWindows } from './keys'

/** Command-Comma on macOS (Control-Comma on Windows): the platform's Settings shortcut, no other modifier. */
export function isSettingsShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>,
  windows = isWindows
): boolean {
  if (event.key !== ',' || event.altKey || event.shiftKey || event.isComposing) return false
  return windows ? event.ctrlKey && !event.metaKey : event.metaKey && !event.ctrlKey
}

/** Opens Settings on Command-Comma while the overlay has keyboard focus (HIG: the app's Settings… item). It only
 *  ever opens: pressing it again with Settings showing leaves Settings where it is. No global shortcut. */
export function useSettingsShortcut(open: () => void): void {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isSettingsShortcut(e)) return
      e.preventDefault()
      openRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** Routes the window-level Escape key to the handler App keeps current in `escapeRef`. */
export function useEscapeKeyListener(escapeRef: MutableRefObject<() => void>): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return // D11: the IME owns Escape mid-composition
      e.preventDefault()
      escapeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * The overlay is always the compact bar — Settings opens as a panel BELOW it (Tony: keep the
 * Métis menu at the top, don't take over the window). Opening Settings from Hide/Island must
 * still expand to a full Settings surface (MQA-286), never the 8×2 / island peek.
 */
export function useSettingsWindowMode(view: RendererView): void {
  useEffect(() => {
    void window.toto.windowMode('bar')
  }, [])
  const prevViewRef = useRef(view)
  useEffect(() => {
    if (view === 'settings') void window.toto.windowMode('settings')
    else if (prevViewRef.current === 'settings') void window.toto.windowMode('bar')
    prevViewRef.current = view
  }, [view])
}
