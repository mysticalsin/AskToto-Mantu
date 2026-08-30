# Island placement

One rule: the peek sits fully below the Mac notch. Hover or click grows the bar **down** from that same top edge. Leave collapses back to the peek.

- **Path A.** Use `display.workArea.y` — Electron’s top-left safe inset under the notch / menu bar. Do not park at `bounds.y = 0`; that clips the capsule in the hardware island.
- **Path C.** If `workArea.y` is 0 (Electron reported no inset) on a notched display, add a strut (`menuBarHeight`, or 37px) so the capsule still clears the notch.

Peek and revealed share that Y. Height changes; Y does not. Leave-hide is the existing auto-hide reducer (`pointer-leave` → grace → peek).
