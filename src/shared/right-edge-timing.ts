/**
 * right-edge-timing.ts — every right-edge timing constant (M2-0202, spec v3 §4), one module for main and the
 * renderer. Each value lies inside its kit §5.4 range in RIGHT_EDGE_TIMING_RANGES (RE-T01). Top-center
 * timings are not right-edge constants and stay where they are (cursor-watch.ts TOP_CENTER_REVEAL_DWELL_MS,
 * overlay-autohide.ts).
 */

/** Continuous pointer rest on the reveal band before the surface opens. */
export const RE_REVEAL_DWELL_MS = 150
/** A keyboard, tray or relaunch reveal the pointer never visits reports a leave after this long away. */
export const RE_UNHOVERED_REVEAL_GRACE_MS = 3000
/** The typing pin holds the surface open this long after the last keystroke (a composer pointerdown counts). */
export const RE_TYPING_PIN_MS = 8000
/** The Reader fades in this long after main has set its bounds (spec v3 §6). */
export const RE_READER_CROSSFADE_MS = 120
/** A tray click blurs the window before its toggle arrives: a tray toggle this soon after a blur park of the
 *  Reader is that same Hide, never a reveal. The hotkey never blurs the window, so the grace is tray-only. */
export const RE_BLUR_TOGGLE_GRACE_MS = 500

/** Inclusive [min, max] per constant (kit §5.4). */
export const RIGHT_EDGE_TIMING_RANGES = {
  RE_REVEAL_DWELL_MS: [100, 250],
  RE_UNHOVERED_REVEAL_GRACE_MS: [2000, 5000],
  RE_TYPING_PIN_MS: [5000, 10000],
  RE_READER_CROSSFADE_MS: [100, 160],
  RE_BLUR_TOGGLE_GRACE_MS: [300, 700]
} as const satisfies Record<string, readonly [number, number]>

export const RIGHT_EDGE_TIMINGS = {
  RE_REVEAL_DWELL_MS,
  RE_UNHOVERED_REVEAL_GRACE_MS,
  RE_TYPING_PIN_MS,
  RE_READER_CROSSFADE_MS,
  RE_BLUR_TOGGLE_GRACE_MS
} as const satisfies Record<keyof typeof RIGHT_EDGE_TIMING_RANGES, number>
