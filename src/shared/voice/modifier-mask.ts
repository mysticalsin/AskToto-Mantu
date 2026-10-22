/**
 * modifier-mask.ts — the wire protocol of the global hold-chord helpers (V01), shared by main and the tests.
 *
 * Both platform helpers (`metis-mac-helper watch-modifiers`, and the unbuilt Windows `metis-keywatch.exe`) print
 * one line only when something changed:
 *
 *     m <modifierMask> <otherInputSeq>
 *
 * `modifierMask` says which modifier keys are down, with the side (left or right) kept, because the owner's default
 * chord is Right Command alone. `otherInputSeq` is a wrapping 32-bit counter that rises with every non-modifier
 * key-down and mouse-button-down (and scroll tick). It tells the recognizer "something else was pressed" without
 * saying what: the protocol has no field for a key code, so no key identity can reach main by construction.
 *
 * The bit values below are mirrored in native/mac-helper/main.swift (`modLeftControl` and friends); a contract test
 * pins the two copies together.
 */

export const MODIFIER_BITS = {
  leftControl: 1,
  rightControl: 2,
  /** Option on macOS, Alt on Windows. */
  leftAlt: 4,
  rightAlt: 8,
  /** Command on macOS. On Windows this is the Windows key, which no chord uses. */
  leftCommand: 16,
  rightCommand: 32,
  leftShift: 64,
  rightShift: 128,
  fn: 256,
  /** A modifier family reported as down without saying which side. Never matches a sided chord (fails closed). */
  unsided: 512
} as const

export const MODIFIER_MASK_MAX = 1023
export const MODIFIER_SEQ_MAX = 4_294_967_295

export interface ModifierSample {
  readonly mask: number
  readonly seq: number
}

export type ChordPlatform = 'darwin' | 'win32'

/**
 * Default hold-to-talk chord per platform (owner decision, NEEDS_TONY 2026-10-21 19:30).
 * darwin: hold Right Command alone (PROVIDED).
 * win32: hold Right Ctrl alone (PROPOSED/ASSUMED by the same decision; unconfirmed on real hardware). Right Ctrl, not
 * Left Ctrl + Left Alt, so AltGr (which Windows reports as Left Ctrl + Right Alt) can never match.
 */
export const CHORD_PLATFORM_DEFAULTS: Readonly<Record<ChordPlatform, number>> = Object.freeze({
  darwin: MODIFIER_BITS.rightCommand,
  win32: MODIFIER_BITS.rightControl
})

const LINE_SHAPE = /^m (\d{1,4}) (\d{1,10})$/

/**
 * Parse one helper line. Returns null for anything that is not exactly `m <int> <int>` in range. A single trailing
 * carriage return is tolerated (Windows pipes); nothing else is.
 */
export function parseModifierLine(line: string): ModifierSample | null {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const match = LINE_SHAPE.exec(trimmed)
  if (!match) return null
  const mask = Number(match[1])
  const seq = Number(match[2])
  if (mask > MODIFIER_MASK_MAX || seq > MODIFIER_SEQ_MAX) return null
  return { mask, seq }
}

const CONTROL_BITS = MODIFIER_BITS.leftControl | MODIFIER_BITS.rightControl
const ALT_BITS = MODIFIER_BITS.leftAlt | MODIFIER_BITS.rightAlt

/** Control+Option is the VoiceOver modifier. A chord holding both collides with it while assistive technology runs. */
export function chordConflictsWithScreenReader(chordMask: number, assistiveTechnologyActive: boolean): boolean {
  return assistiveTechnologyActive && (chordMask & CONTROL_BITS) !== 0 && (chordMask & ALT_BITS) !== 0
}
