import { useEffect, useState, type ReactNode } from 'react'

/** Idle Bar with the 64 thinking-orb in the toolbar: input row (~48) + orb toolbar (~72) + borders. */
export const PANEL_BAR_PX = 124
/** Stealth root `p-5` (20+20). The wider of the two live paddings; `p-1.5` is smaller and still fits. */
export const PANEL_ROOT_PAD_PX = 40
/** App root `gap-2` between Bar and Panel. */
export const PANEL_GAP_PX = 8
/** Non-panel chrome stacked above/around the Review (and History / Agenda / Brain) shell. */
export const PANEL_CHROME_PX = PANEL_BAR_PX + PANEL_ROOT_PAD_PX + PANEL_GAP_PX
/** Matches `BOTTOM_RESERVE_PX` in `src/main/island/geometry.ts` — main's `workArea.height - 48` clamp. */
export const WINDOW_BOTTOM_RESERVE_PX = 48
/** Worst-case grow from `useAutoResize`'s `ceil((h + 2) / 24) * 24` grid. */
export const RESIZE_QUANTIZE_PX = 25
export const PANEL_MIN_PX = 320

/**
 * Cap the panel so the overlay grows to fit long content — the post-meeting Review (Summary +
 * transcript), History, Agenda, Brain — and only scrolls once it would run off the bottom.
 *
 * The reserve is the live chrome budget, not a guess: Bar (including the 64 orb), root padding, gap,
 * resize quantization, and main's workArea-48 ceiling. A smaller reserve (the old `avail - 160`) left
 * a dead band where recap content was taller than the clamped window but shorter than the panel cap,
 * so `overflow-y: auto` never armed and `html/body` (`overflow: hidden`) clipped the last lines with
 * no way to scroll. Computed PER RENDER (not frozen at module load) so it tracks the current display
 * after the overlay is moved between monitors. Never derived from `window.innerHeight` — the window
 * is content-sized from this panel, the same circularity MQA-198 closed for the in-bar answer.
 */
export function panelMaxHeight(
  availHeight: number | undefined = typeof window !== 'undefined' ? window.screen?.availHeight : undefined
): number {
  if (!availHeight || !Number.isFinite(availHeight)) return PANEL_MIN_PX
  const reserve = PANEL_CHROME_PX + WINDOW_BOTTOM_RESERVE_PX + RESIZE_QUANTIZE_PX
  return Math.max(PANEL_MIN_PX, Math.round(availHeight - reserve))
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
      data-panel-scroll
      className="glass-strong scroll-thin panel-enter min-h-0 overflow-y-auto overscroll-y-contain rounded-[var(--radius-outer)] px-4 py-3.5"
      style={{ maxHeight }}
    >
      {children}
    </div>
  )
}
