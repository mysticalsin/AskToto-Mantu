import type { ReactNode } from 'react'

// Cap the answer panel to the screen (minus room for the bar + quick-actions) so the overlay GROWS to fit a
// long answer instead of clipping at a fixed height; it only scrolls once it would run off the bottom.
// Computed PER RENDER (not frozen at module load) so it tracks the current display after the overlay is
// moved between monitors. Main clamps the window to the overlay display's workArea-48 as the hard ceiling.
function panelMaxHeight(): number {
  return typeof window !== 'undefined' && window.screen?.availHeight
    ? Math.max(460, Math.round(window.screen.availHeight - 200))
    : 670
}

export function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="glass-strong scroll-thin panel-enter overflow-y-auto rounded-[var(--radius-outer)] px-4 py-3.5"
      style={{ maxHeight: panelMaxHeight() }}
    >
      {children}
    </div>
  )
}
