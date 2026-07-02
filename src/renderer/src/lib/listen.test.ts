import { describe, it, expect } from 'vitest'
import { isQuestion, looksLikeNetworkError } from './listen'

// Guards the auto-answer trigger. The live VAD endpoint is a snappy 0.6s (vad.ts), which can split a
// hesitated question across two transcription windows. isQuestion must NOT fire on the truncated first
// fragment (which would run the LLM on half a question and then get the complete one throttled out), but
// MUST fire once the coalesced 'them' turn (themRunRef in useListen joins the windows) reads as complete.
describe('isQuestion — auto-answer turn detection', () => {
  it('fires on a complete question (interrogative opener, ≥3 words)', () => {
    expect(isQuestion('What is the best way to deploy this')).toBe(true)
    expect(isQuestion('Can you explain the architecture')).toBe(true)
    expect(isQuestion('How do we handle retries')).toBe(true)
  })

  it('fires on any string with terminal "?" even when short', () => {
    expect(isQuestion('Ready?')).toBe(true)
    expect(isQuestion('You sure?')).toBe(true)
  })

  it('keeps stranded-preposition questions (they DO end real questions)', () => {
    expect(isQuestion('Where are you from')).toBe(true)
    expect(isQuestion('What are you looking at')).toBe(true)
  })

  it('does NOT fire on a fragment that dangles on a function word (cut mid-question)', () => {
    expect(isQuestion('What is the')).toBe(false) // the verifier's exact split case
    expect(isQuestion('Can you give me your')).toBe(false)
    expect(isQuestion('How do we deal with the')).toBe(false)
    expect(isQuestion('Why is this good and')).toBe(false)
  })

  it('resolves a split question once the coalesced run completes', () => {
    // themRunRef joins consecutive 'them' windows; isQuestion runs on the join.
    const fragment1 = 'What is the'
    const fragment2 = 'best way to deploy this'
    expect(isQuestion(fragment1)).toBe(false) // no premature fire on the truncated fragment
    expect(isQuestion(`${fragment1} ${fragment2}`)).toBe(true) // fires once, complete
  })

  it('does not fire on statements or non-interrogative speech', () => {
    expect(isQuestion('I think we should ship it')).toBe(false)
    expect(isQuestion('best way to deploy this')).toBe(false) // no interrogative opener
    expect(isQuestion('what is')).toBe(false) // under the 3-word floor, no "?"
    expect(isQuestion('')).toBe(false)
  })
})

// Guards the Whisper offline-recovery gate (useListen's armNetworkRetry): decides whether a model-load
// failure should show "you're offline, restarting automatically" + auto-retry on reconnect, vs. surface
// the raw error untouched. Must say yes whenever the browser reports offline (regardless of message), and
// must say yes for an online failure whose message is a recognizable network error — but must NOT claim
// "offline" for an unrelated load failure (e.g. a missing bundled file) while genuinely online.
describe('looksLikeNetworkError — Whisper offline-recovery gate', () => {
  it('is true whenever the browser is offline, regardless of the error text', () => {
    expect(looksLikeNetworkError('anything at all', false)).toBe(true)
    expect(looksLikeNetworkError('', false)).toBe(true)
    expect(looksLikeNetworkError('missing local file: model.onnx', false)).toBe(true)
  })

  it('is true online when the message is a recognizable network/fetch failure', () => {
    expect(looksLikeNetworkError('Failed to fetch', true)).toBe(true)
    expect(looksLikeNetworkError('NetworkError when attempting to fetch resource.', true)).toBe(true)
    expect(looksLikeNetworkError('getaddrinfo ENOTFOUND huggingface.co', true)).toBe(true)
    expect(looksLikeNetworkError('connect ECONNREFUSED 127.0.0.1:443', true)).toBe(true)
  })

  it('is false online for an unrelated load failure — must not wrongly claim "offline"', () => {
    expect(looksLikeNetworkError('missing local file: model.onnx', true)).toBe(false)
    expect(looksLikeNetworkError('Unexpected token < in JSON at position 0', true)).toBe(false)
    expect(looksLikeNetworkError('out of memory', true)).toBe(false)
  })
})
