import { useEffect, useState, type ReactNode } from 'react'

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

/** Re-read that cap when the overlay lands on a different display. A display change produces no React
 *  state change of its own — a drag is a main-process setBounds — so per-render recomputation alone never
 *  fires. main re-clamps the window to the new display's work area (clampHeight in src/main/index.ts), and
 *  that viewport resize is the signal. Without it a panel sized for a 4K monitor stays laid out ~1000px
 *  taller than the window it now lives in on a laptop screen, clipping at the frame with no scrollbar.
 *  Exported so the display change is testable without a DOM renderer — this suite has none, which is why
 *  Bar likewise exports answerBodyMaxHeight. */
export function subscribeMaxHeight(onChange: (maxHeight: number) => void): () => void {
  const read = (): void => onChange(panelMaxHeight())
  window.addEventListener('resize', read)
  return () => window.removeEventListener('resize', read)
}

export function Panel({ children }: { children: ReactNode }): JSX.Element {
  // Content-driven resizes fire on every streamed token; each one re-reads the same availHeight, and a
  // setState to an unchanged value costs no re-render — so only a real display change moves the cap.
  const [maxHeight, setMaxHeight] = useState(panelMaxHeight)
  useEffect(() => subscribeMaxHeight(setMaxHeight), [])
  return (
    <div
      className="glass-strong scroll-thin panel-enter overflow-y-auto rounded-[var(--radius-outer)] px-4 py-3.5"
      style={{ maxHeight }}
    >
      {children}
    </div>
  )
}
