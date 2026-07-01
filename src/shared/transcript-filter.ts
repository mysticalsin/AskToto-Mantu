/**
 * Recognise transcript lines that carry no real speech — ASR artifacts that should never reach the
 * displayed or saved transcript. Two families:
 *   1. Phantom phrases the model hallucinates on silence ("you", "thanks for watching", "bye"…).
 *   2. Caption-style sound events emitted for non-speech audio: a whole line wrapped in brackets or
 *      parentheses ("[BELL RINGS]", "[MUSIC]", "[BLANK_AUDIO]", "(applause)") or a musical-note run ("♪♪♪").
 *
 * Match only when the ENTIRE line is one of these — never a substring — so genuine speech that merely
 * contains a parenthetical ("he said (loudly) hi") is preserved. Shared by the live capture path
 * (drops the line before it enters state, so it is never saved) and the recap view (cleans lines that
 * were saved by older builds before this filter existed).
 */
const PHANTOM = new Set(['you', 'thank you', 'thanks for watching', 'thanks', 'bye', 'okay', 'ok'])

// Whole-line bracketed/parenthesised caption, or a line that is only musical-note glyphs / starts with one.
const CAPTION = /^[[(].*[\])]$|^♪+.*$/

export function isNonSpeechLine(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (CAPTION.test(trimmed)) return true
  const norm = trimmed.toLowerCase().replace(/[.!?\s]+$/g, '')
  return PHANTOM.has(norm)
}
