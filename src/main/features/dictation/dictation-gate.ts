/**
 * Narrow recognizer-output rejection for G25. This gate does not infer silence from words or clean transcript text.
 * Only empty/whitespace input and exact, whole-utterance recognizer sentinels are rejected.
 */
const SENTINEL_UTTERANCE =
  /^(?:\[BLANK_AUDIO\]|<\|NOSPEECH\|>|<\|ENDOFTEXT\|>)(?:\s+(?:\[BLANK_AUDIO\]|<\|NOSPEECH\|>|<\|ENDOFTEXT\|>))*$/iu

export function isEmptyOrRecognizerSentinel(text: string): boolean {
  const utterance = text.trim()
  return utterance.length === 0 || SENTINEL_UTTERANCE.test(utterance)
}
