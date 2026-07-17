/**
 * hash.ts — a tiny, dependency-free content hash shared by main and renderer so both processes agree on
 * "the conversation state right now". This is the stable key the speculative "what to say next"
 * pre-generation uses to decide whether an already-generated suggestion still matches the live transcript
 * (adopt it instantly) or is stale (fall through to a real run). Mirrors the FNV-1a in
 * main/screen-preprocess.ts byte-for-byte so a value computed in either process is identical.
 */

/** 32-bit FNV-1a over a string. Deterministic, fast, non-cryptographic — good only for dedupe/equality. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The exact input the on-device suggest model sees is the last `maxChars` of the transcript (matching
 *  llm/shared.ts userText for mode:'suggest'). Keying the speculative cache on a hash of that slice makes
 *  the instant-adopt decision precise — a suggestion is reused only when the conversation state that
 *  produced it still holds, not merely "within N lines". */
export function transcriptStateKey(transcript: string, maxChars = 6000): number {
  return fnv1a(transcript.slice(-maxChars))
}
