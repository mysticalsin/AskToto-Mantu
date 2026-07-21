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
  // Strip a trailing period (and whitespace) before matching the phantom set — but NOT a trailing "?"
  // or "!". A hallucinated phantom is flat filler the model tacks onto silence ("Thank you.", "okay.")
  // and is never spoken with real intonation, whereas a genuine short reaction from the other side
  // ("Ok?", "Bye?", "Okay!") keeps that punctuation. Leaving "?"/"!" in place means those real
  // utterances no longer normalize down to a bare PHANTOM entry, so they pass through as real speech.
  const norm = trimmed.toLowerCase().replace(/[.\s]+$/g, '')
  return PHANTOM.has(norm)
}

// Repetition-loop guards. Whisper decodes each ≤6s live window padded to its fixed 30s context; on
// noisy or low-information audio (loopback bleed, music, a language the compact model struggles with)
// the decoder can fall into a loop and emit the same phrase over and over — both INSIDE one decoded
// line and ACROSS consecutive windows. Real speech almost never repeats the exact same normalized word
// run 3+ times back-to-back, so collapsing/limiting at that threshold loses nothing genuine.

const REPEAT_MIN = 3 // 3+ consecutive identical runs = a decoder loop, not speech
const REPEAT_MAX_UNIT_WORDS = 12 // longest phrase unit worth scanning for (loops are short phrases)

/** True when the `unit`-word run at `at` equals the one at `from` (both indices into `norm`). */
function sameRun(norm: string[], from: number, at: number, unit: number): boolean {
  for (let j = 0; j < unit; j++) if (norm[from + j] !== norm[at + j]) return false
  return true
}

/**
 * Collapse a phrase the decoder looped INSIDE one line ("vamos ver vamos ver vamos ver…" → "vamos ver
 * vamos ver"). Word-level: any 1..REPEAT_MAX_UNIT_WORDS-word unit repeated REPEAT_MIN+ times
 * consecutively is collapsed to two occurrences — two, not one, so genuine emphasis ("no, no") survives.
 * Comparison ignores case and trailing punctuation; the kept words stay verbatim.
 */
export function collapseRepeatedPhrase(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < REPEAT_MIN) return text
  const norm = words.map((w) => w.toLowerCase().replace(/[.,!?…]+$/g, ''))
  for (let unit = 1; unit <= Math.min(REPEAT_MAX_UNIT_WORDS, Math.floor(words.length / REPEAT_MIN)); unit++) {
    for (let i = 0; i + unit * REPEAT_MIN <= words.length; i++) {
      let repeats = 1
      while (i + (repeats + 1) * unit <= words.length && sameRun(norm, i, i + repeats * unit, unit)) repeats++
      if (repeats >= REPEAT_MIN) {
        const collapsed = [...words.slice(0, i + unit * 2), ...words.slice(i + repeats * unit)].join(' ')
        return collapseRepeatedPhrase(collapsed) // catch a second, different loop later in the line
      }
    }
  }
  return text
}

/**
 * Normalized identity key for the cross-line half of the guard: the live path counts consecutive
 * committed lines with the same key (same speaker) and stops appending after two, so a looping decoder
 * returning the identical line for window after window can't fill the transcript with dozens of copies.
 */
export function repeatKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?…\s]+$/g, '')
}
