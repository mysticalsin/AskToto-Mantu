import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isQuestion, looksLikeNetworkError, shouldProbeLanguageWindow, themDeviceChangeAction } from './listen'

// Normalize CRLF → LF (same rationale as App.mic-only-visibility.test.ts): Windows checkouts would
// otherwise break any anchor whose newline sits mid-string.
const listenSrc = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')

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

  it('fires on Latin questions with typographic apostrophes/accents (ASR emits curly quotes)', () => {
    expect(isQuestion('What’s the timeline for this')).toBe(true) // U+2019 curly apostrophe
    expect(isQuestion('How do we handle L’Oréal’s account')).toBe(true) // curly apostrophe + accent
    expect(isQuestion('Can you describe the naïve approach')).toBe(true) // accented Latin
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

// MQA-011 — a 'them' channel killed by a mid-meeting device change (default output switched to a headset)
// stays readyState 'live' and fires no 'ended' event; it just delivers silence. The only 'them' detector,
// armThemWatchdog, disarms permanently after the first window, and recoverSystemAudio refuses to run while
// a channel is still registered — so the remote half of the meeting was lost for the rest of the session
// while the Bar's "Heard live" chip and the pill's red dot kept claiming health. The device change now puts
// the channel on probation: prove yourself with one window, or be recycled.
describe('themDeviceChangeAction — them-side silent-death recovery (MQA-011)', () => {
  it('puts a still-registered them channel on probation instead of trusting it', () => {
    expect(themDeviceChangeAction(true, true, null)).toBe('watch')
  })

  it('recycles a them channel that emitted nothing for the whole probation window', () => {
    // The zombie: registered, 'live', silent. Without the probation this state is unreachable — the
    // watchdog is disarmed for the life of the channel once any window has been heard.
    expect(themDeviceChangeAction(true, true, false)).toBe('recycle')
  })

  it('leaves a them channel that proved itself alone (no gratuitous SCStream restart on a device blip)', () => {
    expect(themDeviceChangeAction(true, true, true)).toBe('ignore')
  })

  it('re-acquires straight away when the session wants system audio but has no them channel', () => {
    expect(themDeviceChangeAction(true, false, null)).toBe('recover')
  })

  it('never touches the loopback for a mic-only session', () => {
    expect(themDeviceChangeAction(false, false, null)).toBe('ignore')
    expect(themDeviceChangeAction(false, true, false)).toBe('ignore')
  })

  it('is wired into the devicechange handler, the probation timer, and the them audio callback', () => {
    // The handler used to bail on `!channels.current.you`, so a system-only session never even reached it.
    expect(listenSrc).toMatch(/if \(channels\.current\.you\) void recoverMicRef\.current\?\.\(\)/)
    expect(listenSrc).toMatch(/themDeviceChangeAction\(wantsSystemRef\.current, !!channels\.current\.them, null\)/)
    expect(listenSrc).toMatch(/if \(action === 'watch'\) armThemProbation\(\)/)
    // The recycle must close the channel first — recoverSystemAudio returns early while one is registered.
    expect(listenSrc).toMatch(/if \(verdict !== 'recycle'\) return[\s\S]{0,200}closeChannel\('them'\)/)
    expect(listenSrc).toMatch(/void recoverSystemAudioRef\.current\?\.\(\)\n {4}\}, THEM_WATCHDOG_MS\)/)
    // Proof-of-life is recorded per window; nothing heavier than a boolean store on the capture path.
    expect(listenSrc).toMatch(/themWindowSeenRef\.current = true/)
  })
})

// MQA-012 — with the shipped default spoken language 'auto', an un-pinned whisper decode is hard-coded to
// English by transformers.js, so the Parakeet probe is the ONLY thing that can pin the real language. It
// used to retire after PROBE_WINDOW_BUDGET windows even when it had never landed a pin: a Portuguese call
// whose five opening windows are short ("Oi", "Tudo bem?" — all under PROBE_MIN_WORDS) was then decoded as
// English for its entire duration, with no in-meeting recovery.
describe('shouldProbeLanguageWindow — auto-language probe cadence (MQA-012)', () => {
  it('probes every one of the opening windows while un-pinned', () => {
    expect([1, 2, 3, 4, 5].map((n) => shouldProbeLanguageWindow(n, false))).toEqual([true, true, true, true, true])
  })

  it('keeps probing past the opening budget when no pin ever landed', () => {
    // The regression: window 6 onward used to be false forever, so no pinLanguage could ever be produced.
    expect(shouldProbeLanguageWindow(8, false)).toBe(true)
    expect(shouldProbeLanguageWindow(12, false)).toBe(true)
    expect(shouldProbeLanguageWindow(400, false)).toBe(true) // still trying an hour in
  })

  it('drops to the steady PROBE_EVERY cadence after the burst, not every window', () => {
    // Un-pinned probing must not become a per-window IPC round trip — same load as the pinned case.
    expect([6, 7, 9, 10, 11].map((n) => shouldProbeLanguageWindow(n, false))).toEqual([
      false,
      false,
      false,
      false,
      false
    ])
  })

  it('leaves the pinned re-probe cadence untouched (every 4th window, no opening burst)', () => {
    expect(shouldProbeLanguageWindow(1, true)).toBe(false)
    expect(shouldProbeLanguageWindow(3, true)).toBe(false)
    expect(shouldProbeLanguageWindow(4, true)).toBe(true)
    expect(shouldProbeLanguageWindow(8, true)).toBe(true)
  })

  it('is the cadence pump() actually uses', () => {
    expect(listenSrc).toMatch(
      /shouldProbeLanguageWindow\(probeWindowCountRef\.current, probePinnedRef\.current\)/
    )
  })
})
