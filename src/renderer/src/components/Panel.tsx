import type { ReactNode } from 'react'

// Cap the panel to the screen (minus the bar's overhead above it) so the overlay GROWS to fit long content
// — the post-meeting Review (Overview + full transcript), History, Agenda — instead of clipping at a fixed
// height; it only scrolls once it would run off the bottom. The ~160 reserve covers the bar + gaps + padding
// while staying clear of main's workArea-48 hard ceiling (so the panel never clips behind the window edge).
// Panels never sit under the quick-actions row (that's the in-bar answer surface), so the old 200 reserve was
// over-conservative and left the review surface needlessly cramped. Computed PER RENDER (not frozen at module
// load) so it tracks the current display after the overlay is moved between monitors.
function panelMaxHeight(): number {
  return typeof window !== 'undefined' && window.screen?.availHeight
    ? Math.max(460, Math.round(window.screen.availHeight - 160))
    : 700
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
