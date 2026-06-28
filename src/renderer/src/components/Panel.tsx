import type { ReactNode } from 'react'

// Cap the answer panel to the physical screen (minus room for the bar + quick-actions) so the overlay
// GROWS to fit a long answer instead of clipping at a fixed height; it only scrolls once it would run off
// the bottom of the screen. The main process still clamps the window to workArea.height - 48 as the ceiling.
const PANEL_MAX_H =
  typeof window !== 'undefined' && window.screen?.availHeight
    ? Math.max(460, Math.round(window.screen.availHeight - 200))
    : 670

export function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="glass-strong scroll-thin panel-enter overflow-y-auto rounded-2xl px-4 py-3.5"
      style={{ maxHeight: PANEL_MAX_H }}
    >
      {children}
    </div>
  )
}
