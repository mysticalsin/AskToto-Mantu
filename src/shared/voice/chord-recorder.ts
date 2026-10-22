/**
 * chord-recorder.ts: the pure rules behind the Settings chord recorder (V06).
 *
 * The recorder (renderer) turns DOM key codes into the watcher's own chord tokens (`VOICE_CHORD_TOKENS`), and this
 * module says whether a held set is a chord Métis will take, in one inline sentence, and what to explain beside a
 * chord that is allowed. A single modifier such as Right Command is a valid chord: the hold watcher matches the
 * exact modifier mask, so the shortcut does not need a letter key (and so no key identity, no Input Monitoring).
 *
 * Copy rules (HIG S6 and the design's section 11): sentence case, one sentence, a full stop, no em dash, never "Error".
 */
import { VOICE_CHORD_TOKENS, type VoiceChordToken } from '../voice-actions-settings'

export type ChordRecorderPlatform = 'darwin' | 'win32'

/** A hold must last this long before it counts; a shorter press is a tap, not a chosen chord. */
export const RECORD_MIN_HOLD_MS = 400
const MAX_CHORD_KEYS = 4

const CODE_TOKENS: Readonly<Record<string, VoiceChordToken>> = Object.freeze({
  ControlLeft: 'leftControl',
  ControlRight: 'rightControl',
  AltLeft: 'leftAlt',
  AltRight: 'rightAlt',
  MetaLeft: 'leftCommand',
  MetaRight: 'rightCommand',
  ShiftLeft: 'leftShift',
  ShiftRight: 'rightShift'
})

/** `KeyboardEvent.code` of a modifier key, as a chord token. Fn and every other key have no DOM code here: null. */
export function tokenForKeyCode(code: string): VoiceChordToken | null {
  return Object.hasOwn(CODE_TOKENS, code) ? CODE_TOKENS[code] : null
}

/** Unique tokens in the watcher's own order, so the same keys always store the same chord. */
export function canonicalChord(tokens: Iterable<VoiceChordToken>): VoiceChordToken[] {
  const held = new Set(tokens)
  return VOICE_CHORD_TOKENS.filter((token) => held.has(token))
}

const SIDE = { left: 'Left', right: 'Right' } as const
type Family = 'control' | 'alt' | 'command' | 'shift' | 'fn'

const FAMILY: Readonly<Record<VoiceChordToken, Family>> = {
  leftControl: 'control',
  rightControl: 'control',
  leftAlt: 'alt',
  rightAlt: 'alt',
  leftCommand: 'command',
  rightCommand: 'command',
  leftShift: 'shift',
  rightShift: 'shift',
  fn: 'fn'
}

const GLYPH: Record<Family, string> = { control: '⌃', alt: '⌥', command: '⌘', shift: '⇧', fn: 'Fn' }
const WIN_WORD: Record<Family, string> = { control: 'Ctrl', alt: 'Alt', command: 'Win', shift: 'Shift', fn: 'Fn' }
const MAC_NAME: Record<Family, string> = {
  control: 'Control',
  alt: 'Option',
  command: 'Command',
  shift: 'Shift',
  fn: 'Fn'
}
const WIN_NAME: Record<Family, string> = {
  control: 'Control',
  alt: 'Alt',
  command: 'Windows key',
  shift: 'Shift',
  fn: 'Fn'
}

const sideOf = (token: VoiceChordToken): 'Left' | 'Right' | null =>
  token.startsWith('left') ? SIDE.left : token.startsWith('right') ? SIDE.right : null

function label(token: VoiceChordToken, words: Record<Family, string>, glyphs: boolean): string {
  const family = FAMILY[token]
  const side = sideOf(token)
  const name = glyphs ? GLYPH[family] : words[family]
  return side ? `${side} ${name}` : name
}

/** One short label per held key, for the chips: "Right ⌘" on macOS, "Right Ctrl" on Windows. */
export function chordChips(tokens: readonly VoiceChordToken[], platform: ChordRecorderPlatform): string[] {
  return tokens.map((token) => label(token, WIN_WORD, platform === 'darwin'))
}

/** The full key names for a screen reader: "Right Command", "Left Control and Left Option". */
export function chordSpoken(tokens: readonly VoiceChordToken[], platform: ChordRecorderPlatform): string {
  const names = platform === 'darwin' ? MAC_NAME : WIN_NAME
  return tokens.map((token) => label(token, names, false)).join(' and ')
}

const has = (tokens: readonly VoiceChordToken[], family: Family): boolean =>
  tokens.some((token) => FAMILY[token] === family)

export type ChordValidation = { ok: true } | { ok: false; message: string }

/** Whether a held set is a chord Métis takes. The message is the one inline sentence shown beside the field. */
export function validateChord(tokens: readonly VoiceChordToken[], platform: ChordRecorderPlatform): ChordValidation {
  const fail = (message: string): ChordValidation => ({ ok: false, message })
  if (tokens.length === 0) return fail('Hold at least one modifier key.')
  if (tokens.length > MAX_CHORD_KEYS) return fail('Use four keys or fewer.')
  const example = platform === 'darwin' ? 'Right ⌘' : 'Right Ctrl'
  if (tokens.every((token) => FAMILY[token] === 'shift')) {
    return fail(`Shift alone is held while you type. Choose another key, like ${example}.`)
  }
  if (platform === 'darwin' && has(tokens, 'command') && has(tokens, 'shift')) {
    return fail('⌘ with ⇧ starts many app shortcuts. Choose another combination.')
  }
  if (platform === 'win32' && has(tokens, 'command')) {
    return fail('The Windows key opens Start. Choose Ctrl or Alt instead.')
  }
  if (platform === 'win32' && tokens.includes('leftControl') && tokens.includes('rightAlt')) {
    return fail('Left Ctrl with Right Alt is AltGr on many keyboards. Choose another combination.')
  }
  return { ok: true }
}

/** Explanations that stay beside a chord that is allowed (a conflict that is the person's call, not a refusal). */
export function chordNotes(tokens: readonly VoiceChordToken[], platform: ChordRecorderPlatform): string[] {
  const notes: string[] = []
  if (platform === 'darwin' && has(tokens, 'control') && has(tokens, 'alt')) {
    notes.push('VoiceOver uses Control and Option together. If you use VoiceOver, choose another shortcut.')
  }
  if (tokens.length === 1) {
    const [only] = tokens
    if (platform === 'darwin' && only === 'leftCommand') {
      notes.push(
        'Left ⌘ starts most shortcuts, so holding it a moment before one briefly starts listening. Right ⌘ avoids that.'
      )
    }
    if (platform === 'win32' && only === 'leftControl') {
      notes.push(
        'Left Ctrl starts most shortcuts, so holding it a moment before one briefly starts listening. Right Ctrl avoids that.'
      )
    }
    if (platform === 'darwin' && only === 'fn') {
      notes.push('Fn (Globe) can be set to start Dictation in System Settings.')
    }
  }
  return notes
}

/**
 * The macOS Dictation shortcut can be a double press of Control, Left or Right Command, or Fn. When the chord is
 * exactly one of those keys, the double-press latch collides with it, so the option says so. Null otherwise.
 */
export function latchDictationNote(tokens: readonly VoiceChordToken[], platform: ChordRecorderPlatform): string | null {
  if (platform !== 'darwin' || tokens.length !== 1) return null
  const [only] = tokens
  if (FAMILY[only] !== 'control' && FAMILY[only] !== 'command' && only !== 'fn') return null
  const key = label(only, WIN_WORD, true)
  return `On macOS, pressing ${key} twice can also start Dictation. Turn that shortcut off in System Settings › Keyboard › Dictation first.`
}
