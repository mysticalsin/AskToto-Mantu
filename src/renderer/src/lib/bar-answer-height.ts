const BAR_CHROME_PX = 96 // input row + toolbar + the padding around the body (BAR_HEIGHT is 84 idle)
const ANSWER_BODY_MIN_PX = 320 // usable floor on a short display; see the ceiling arithmetic below

/** Max height of the in-bar answer body, in px, derived from the DISPLAY rather than the viewport.
 *
 *  This used to be `max-h-[76vh]`, and `vh` resolves against the overlay's own window — whose height is
 *  itself produced by this content: useAutoResize measures the content root, pushes it over IPC, and
 *  main's resizeTo sets the window to it (state.ts / main/index.ts). So the cap was a function of its own
 *  output. H = chrome + 0.76·H settles at H = chrome/0.24, which pinned the window near 360-384px — the
 *  SAME height on a 3840x2160 monitor as on a 1366x768 laptop, ~275px of readable answer either way — and
 *  ratcheted there over several native resizes, because each grow raised the viewport and so raised the
 *  cap again. A screen-derived pixel cap is not a function of the window height, so the loop closes in one
 *  step and the reading area finally scales with the monitor, the way the sibling Panel surface already
 *  does. Read per render (never frozen at module load) so it tracks the display the overlay was moved to,
 *  same as Panel.tsx's panelMaxHeight.
 *
 *  The 76% is kept deliberately — it is now 76% of the SCREEN instead of of itself, so this always-on-top
 *  overlay stays compact over whatever the user is doing rather than filling their display. Since
 *  0.76·avail - chrome + chrome <= avail - 48 holds for any display taller than 200px, the resulting
 *  window also never fights main's `workArea.height - 48` clamp; the floor is likewise below that ceiling
 *  for any display taller than 464px. */
export function answerBodyMaxHeight(
  availHeight: number | undefined = typeof window !== 'undefined' ? window.screen?.availHeight : undefined
): number {
  if (!availHeight || !Number.isFinite(availHeight)) return ANSWER_BODY_MIN_PX
  return Math.max(ANSWER_BODY_MIN_PX, Math.round(availHeight * 0.76) - BAR_CHROME_PX)
}
