import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  advanceLanguageProbe,
  degradedAfterMicRecovery,
  feedEmptyIsEcho,
  isQuestion,
  looksLikeNetworkError,
  probeMinWords,
  probeResultIsStale,
  speakerEmbedResultIsStale,
  shouldProbeLanguageWindow,
  sysRetryDelayMs,
  themDeviceChangeAction,
  themRecoveryFailureIsNoop,
  themTracksLookDead,
  trimQueue
} from './listen'
import type { CaptureDegraded } from './listen'
import { transcriptToText } from './transcript'
import type { TranscriptLine } from '@shared/ipc'

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

// MQA-109 — the MQA-011 probation over-corrected: the devicechange effect arms armThemProbation for EVERY
// 'devicechange' (the Web API fires it for ANY audio/video add/remove, relevant or not), and the timer then
// recycled a channel that emitted no window in 20s. For a channel already confirmed healthy (themHeardRef),
// a normal quiet stretch (you talking, the remote briefly silent) legitimately emits nothing — so bare
// silence must NOT count as death. Recycle a healthy loopback ONLY with positive evidence its tracks died;
// the pre-fix code returned 'recycle' for exactly this input (its own comment says it "must never").
describe('themDeviceChangeAction — a healthy loopback survives an unrelated device blip (MQA-109)', () => {
  it('keeps an already-healthy them channel that only went quiet (no positive death evidence)', () => {
    // Pre-fix, themDeviceChangeAction(true, true, false) hard-returned 'recycle'; the death-evidence flag
    // now spares a still-live, unmuted loopback that merely fell silent for the probation window.
    expect(themDeviceChangeAction(true, true, false, false)).toBe('ignore')
  })

  it('still recycles a quiet channel when its tracks show positive evidence of death (MQA-011 preserved)', () => {
    expect(themDeviceChangeAction(true, true, false, true)).toBe('recycle')
  })

  it('a window during probation keeps the channel regardless of the death-evidence flag', () => {
    expect(themDeviceChangeAction(true, true, true, false)).toBe('ignore')
    expect(themDeviceChangeAction(true, true, true, true)).toBe('ignore')
  })
})

describe('themTracksLookDead — positive death evidence for an already-healthy loopback (MQA-109)', () => {
  it('is false while any audio track is still live and unmuted (quiet ≠ dead)', () => {
    expect(themTracksLookDead([{ readyState: 'live', muted: false }])).toBe(false)
    // A dead track alongside a live one is not yet fully dead (still delivering audio).
    expect(
      themTracksLookDead([{ readyState: 'ended', muted: false }, { readyState: 'live', muted: false }])
    ).toBe(false)
  })

  it('is true when every audio track has ended or its source went muted', () => {
    expect(themTracksLookDead([{ readyState: 'ended', muted: false }])).toBe(true)
    expect(themTracksLookDead([{ readyState: 'live', muted: true }])).toBe(true)
    expect(
      themTracksLookDead([{ readyState: 'ended', muted: false }, { readyState: 'live', muted: true }])
    ).toBe(true)
  })

  it('treats an empty track list (channel already torn down) as dead so recovery still fires', () => {
    expect(themTracksLookDead([])).toBe(true)
  })

  it('the probation timer gates recycle on positive death evidence, not bare silence (MQA-109 wiring)', () => {
    // themHeardRef (already-confirmed-healthy) OR a real track anomaly must gate the recycle.
    expect(listenSrc).toMatch(
      /const hasDeathEvidence = !themHeardRef\.current \|\| themTracksLookDead\(ch \? ch\.stream\.getAudioTracks\(\) : \[\]\)/
    )
    expect(listenSrc).toMatch(
      /themDeviceChangeAction\(\s*wantsSystemRef\.current,\s*!!ch,\s*themWindowSeenRef\.current,\s*hasDeathEvidence\s*\)/
    )
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
    expect([7, 9, 11].map((n) => shouldProbeLanguageWindow(n, false))).toEqual([false, false, false])
    expect(shouldProbeLanguageWindow(6, false)).toBe(true) // 6 % 2 === 0
    expect(shouldProbeLanguageWindow(8, false)).toBe(true)
  })

  it('leaves the pinned re-probe cadence untouched (every 2nd window, no opening burst)', () => {
    expect(shouldProbeLanguageWindow(1, true)).toBe(false)
    expect(shouldProbeLanguageWindow(2, true)).toBe(true)
    expect(shouldProbeLanguageWindow(3, true)).toBe(false)
    expect(shouldProbeLanguageWindow(4, true)).toBe(true)
  })

  it('is the cadence pump() actually uses', () => {
    expect(listenSrc).toMatch(
      /shouldProbeLanguageWindow\(probeWindowCountRef\.current, probePinnedRef\.current\)/
    )
  })
})

// MQA-156 — `captureDegraded` is a SINGLE slot but two independent sides can be degraded at once. On a
// mic-only session (Screen Recording denied, so the start-time entry is {side:'them'}), a mic blip wrote
// {side:'you'} over that entry and the mic recovery ~200ms later cleared it outright — so the Bar's chip
// went back to the confident red "Heard live" for the rest of a meeting whose remote half was never being
// captured. That is the exact 2026-07-20 failure the field exists to prevent (see its doc block).
const THEM_PERMISSION_DEGRADED: CaptureDegraded = {
  side: 'them',
  note: 'System audio needs Screen Recording permission. Listening to microphone only; grant it in System Settings → Privacy & Security → Screen Recording, then restart Listen.',
  permission: true
}
const MIC_DEGRADED: CaptureDegraded = {
  side: 'you',
  note: 'Microphone lost (device change or sleep). Reconnecting…',
  permission: false
}

describe('degradedAfterMicRecovery — a mic recovery must not erase a live them degradation (MQA-156)', () => {
  it('MQA-156 — restores the still-live them cause instead of claiming full health', () => {
    // The 2026-07-20 shape: mic-only because Screen Recording is denied, mic drops and comes back.
    expect(degradedAfterMicRecovery(MIC_DEGRADED, THEM_PERMISSION_DEGRADED, true, false)).toEqual(
      THEM_PERMISSION_DEGRADED
    )
  })

  it('MQA-156 — clears the degradation when the mic really was the only side missing', () => {
    expect(degradedAfterMicRecovery(MIC_DEGRADED, null, true, true)).toBeNull() // them channel is live
    expect(degradedAfterMicRecovery(MIC_DEGRADED, null, false, false)).toBeNull() // mic-only session by choice
    // A stale remembered cause must not resurrect a them side that is actually capturing again.
    expect(degradedAfterMicRecovery(MIC_DEGRADED, THEM_PERMISSION_DEGRADED, true, true)).toBeNull()
  })

  it('MQA-156 — leaves a them entry alone (that side clears itself on its own recovery)', () => {
    expect(degradedAfterMicRecovery(THEM_PERMISSION_DEGRADED, THEM_PERMISSION_DEGRADED, true, false)).toEqual(
      THEM_PERMISSION_DEGRADED
    )
    expect(degradedAfterMicRecovery(null, THEM_PERMISSION_DEGRADED, true, false)).toBeNull()
  })

  it('MQA-156 — is what recoverMic writes, and every them-degradation site remembers its cause', () => {
    // The clear site that used to lie.
    expect(listenSrc).toMatch(
      /captureDegraded: degradedAfterMicRecovery\(\s*s\.captureDegraded,\s*themDegradedRef\.current,\s*wantsSystemRef\.current,\s*!!channels\.current\.them\s*\)/
    )
    // Remembered at the start-time mic-only fallback, at a mid-session 'them' death, and at the
    // probation recycle — and dropped again only once 'them' is genuinely capturing (or a new session).
    expect(listenSrc).toMatch(/themDegradedRef\.current = captureDegraded\?\.side === 'them' \? captureDegraded : null/)
    expect(listenSrc).toMatch(/themDegradedRef\.current = \{ side: 'them', note: THEM_LOST_MSG, permission: false \}/)
    expect(listenSrc).toMatch(/themDegradedRef\.current = null/)
  })
})

// MQA-157 — probeLanguageWindow's stale-result guard checked liveRef, which start() re-raises for the NEXT
// session, so a Parakeet probe dispatched by meeting 1 (its first call pays a multi-second sherpa model
// load) could resolve inside meeting 2 and post {type:'pinLanguage'} to the freshly reset worker — pinning
// an English call to the previous meeting's Portuguese. The file already carries the right primitive for
// this (sessionEpochRef, which stop()'s drain checks for exactly the same reason).
describe('probeResultIsStale — a probe must not outlive its session (MQA-157)', () => {
  it('MQA-157 — discards a result dispatched by a session that has since been replaced', () => {
    // liveRef/engine/language all look current in session 2 — only the epoch reveals the leak.
    expect(probeResultIsStale(1, 2, true, 'whisper', 'auto')).toBe(true)
  })

  it('MQA-157 — keeps a result from the session that dispatched it', () => {
    expect(probeResultIsStale(2, 2, true, 'whisper', 'auto')).toBe(false)
  })

  it('MQA-157 — keeps the pre-existing stop/engine/language guards (added to, not replaced)', () => {
    expect(probeResultIsStale(2, 2, false, 'whisper', 'auto')).toBe(true) // stopped
    expect(probeResultIsStale(2, 2, true, 'parakeet', 'auto')).toBe(true) // mid-session engine switch
    expect(probeResultIsStale(2, 2, true, 'apple', 'auto')).toBe(true)
    expect(probeResultIsStale(2, 2, true, 'whisper', 'fr')).toBe(true) // user set an explicit language
  })

  it('MQA-157 — is the guard probeLanguageWindow runs, stamped with the epoch at dispatch time', () => {
    // The stamp must be taken when the probe is FIRED (synchronously inside the session that owns it),
    // not read back out of the ref after the round trip — which is what made liveRef useless here.
    expect(listenSrc).toMatch(
      /const probeLanguageWindow = useCallback\(\(audio: Float32Array, speaker: Speaker\): void => \{\n\s*const epoch = sessionEpochRef\.current/
    )
    expect(listenSrc).toMatch(
      /if \(\s*probeResultIsStale\(\s*epoch,\s*sessionEpochRef\.current,\s*liveRef\.current,\s*engineRef\.current,\s*asrLanguageRef\.current\s*\)\s*\)\s*\n?\s*return/
    )
  })
})

// MQA-163 — the Windows half of the system-audio watcher retried a FULL display-capture acquisition every
// 3 s, unconditionally, for as long as the session wanted system audio and had no 'them' channel. On a
// machine where WASAPI loopback cannot start at all (VDI/RDP with no render endpoint, every output
// disabled, another app holding the endpoint exclusively) that is ~2400 acquisitions in a 2 h meeting —
// and each one that falls through to the video-bound form runs up to 3 desktopCapturer.getSources screen
// enumerations, i.e. the exact screen-grabbing path the audio-only attempt exists to avoid. It also
// re-rendered the whole App tree on that 3 s cadence via a value-identical setState spread.
//
// The retry must stay reachable forever, though: the headline case in the watcher's own comment (another
// app holding the render endpoint) fires no 'devicechange', so a terminal give-up would re-open MQA-041's
// mic-only-for-the-whole-meeting failure. Hence capped backoff, no terminal state.
describe('sysRetryDelayMs — the Windows loopback retry is paced, never abandoned (MQA-163)', () => {
  /** Replay the watcher's 3 s tick loop over a meeting whose loopback never comes back. Mirrors the
   *  effect: skip the tick until the timestamp passes, then arm the next delay off the failure count. */
  const replayTicks = (meetingMs: number): number[] => {
    const fires: number[] = []
    let failures = 0
    let nextAt = 0
    for (let now = 3000; now <= meetingMs; now += 3000) {
      if (now < nextAt) continue
      nextAt = now + sysRetryDelayMs(failures++)
      fires.push(now)
    }
    return fires
  }

  it('MQA-163 — backs off instead of re-acquiring display capture on every 3 s tick', () => {
    expect(sysRetryDelayMs(0)).toBe(3000)
    expect(sysRetryDelayMs(1)).toBe(6000)
    expect(sysRetryDelayMs(2)).toBe(12000)
    expect(sysRetryDelayMs(3)).toBe(24000)
  })

  it('MQA-163 — holds at a ceiling, so a long meeting cannot outrun the schedule', () => {
    expect(sysRetryDelayMs(4)).toBe(30_000)
    expect(sysRetryDelayMs(200)).toBe(30_000) // 3000 * 2**200 overflows to Infinity — still capped
  })

  it('MQA-163 — a 2 h dead-loopback meeting costs a few hundred attempts, not a few thousand', () => {
    const fires = replayTicks(2 * 60 * 60 * 1000)
    expect(fires.length).toBeLessThan(300) // was 2400: one per 3 s tick
  })

  it('MQA-163 — never gives up: still retrying at the end of the meeting', () => {
    // A terminal cap would resurrect MQA-041 for the one failure mode that emits no devicechange.
    const meetingMs = 2 * 60 * 60 * 1000
    const fires = replayTicks(meetingMs)
    expect(meetingMs - fires[fires.length - 1]).toBeLessThanOrEqual(30_000)
    // The opening blip — the case the watcher was written for — is still caught in the first seconds.
    expect(fires[0]).toBe(3000)
  })

  it('MQA-163 — is what the Windows branch of the watcher actually runs', () => {
    // The pre-fix shape: an unconditional re-acquire on every tick.
    expect(listenSrc).not.toMatch(
      /if \(isWindows\) \{\n {8}void recoverSystemAudioRef\.current\?\.\(\)\n {8}return\n {6}\}/
    )
    expect(listenSrc).toMatch(/if \(now < sysRetryNextAtRef\.current\) return/)
    expect(listenSrc).toMatch(
      /sysRetryNextAtRef\.current = now \+ sysRetryDelayMs\(sysRetryAttemptsRef\.current\+\+\)/
    )
    // Reset in all three places recovery becomes plausible again: a new session, a successful re-acquire,
    // and a real device change (which must get an immediate attempt, not wait out the backoff).
    expect(listenSrc.match(/sysRetryAttemptsRef\.current = 0/g)).toHaveLength(3)
  })
})

// MQA-163 (second half) — the failed-retry catch spread a fresh state object every time, so a watcher
// that could never succeed re-rendered App on its own cadence for a value-identical state.
describe('themRecoveryFailureIsNoop — a repeated failure must not re-render the tree (MQA-163)', () => {
  it('MQA-163 — the second and every later failure of a stuck loopback writes nothing', () => {
    // The steady state of the scenario: the note and the degradation entry are both already up, and the
    // retry keeps failing. Under the old code each of those failures spread a fresh state object.
    expect(themRecoveryFailureIsNoop('System-audio capture stopped…', THEM_PERMISSION_DEGRADED)).toBe(true)
  })

  it('MQA-163 — still writes while either half of the state is missing', () => {
    expect(themRecoveryFailureIsNoop(null, null)).toBe(false) // first failure of a mid-session loss
    expect(themRecoveryFailureIsNoop(null, THEM_PERMISSION_DEGRADED)).toBe(false) // note was cleared
    expect(themRecoveryFailureIsNoop('System-audio capture stopped…', null)).toBe(false)
  })

  it('MQA-163 — is the guard the failed-retry catch bails out on', () => {
    expect(listenSrc).toMatch(/themRecoveryFailureIsNoop\(s\.error, s\.captureDegraded\)\n\s*\? s\n\s*:/)
    // The write itself still only ever RAISES — an existing captureDegraded carries the more specific
    // start-time cause (the Screen-Recording copy) and must survive the retry.
    expect(listenSrc).toMatch(/captureDegraded: s\.captureDegraded \?\? \{ side: 'them', note: THEM_LOST_MSG, permission: false \}/)
  })
})

// ASR quality (1B.2a) — the pure trim behind pushAudio's MAX_QUEUE backpressure guard. A naive
// drop-the-front trim can erase every queued window of one speaker's channel when the other channel
// produced a longer burst just ahead of it — trimQueue instead protects the newest already-queued window
// of EACH speaker present, so a caller never loses BOTH sides of the conversation to a one-sided backlog.
describe('trimQueue — backpressure drop keeps the newest window per speaker (1B.2a)', () => {
  const job = (speaker: string, id: number): { speaker: string; id: number } => ({ speaker, id })

  it('is a no-op under the limit', () => {
    const queue = [job('them', 1), job('you', 2)]
    expect(trimQueue(queue, 5)).toEqual(queue)
  })

  it('drops the oldest windows first for a single-speaker backlog', () => {
    const queue = [job('them', 1), job('them', 2), job('them', 3), job('them', 4)]
    const trimmed = trimQueue(queue, 2)
    expect(trimmed.map((j) => j.id)).toEqual([3, 4])
  })

  it('never drops the newest window of a speaker even when the other channel bursts right before it', () => {
    // Five THEM windows queued, then one stale YOU window — a naive front-trim to maxLen=2 would keep
    // only [them4, you5] or worse, but the newest THEM window (them5 doesn't exist here — the point is
    // the LAST 'them' before the trim boundary) must survive alongside the newest 'you'.
    const queue = [job('them', 1), job('them', 2), job('them', 3), job('them', 4), job('them', 5), job('you', 6)]
    const trimmed = trimQueue(queue, 2)
    // Newest 'them' (5) and newest 'you' (6) are both protected, even though that's the exact maxLen.
    expect(trimmed.map((j) => j.id)).toEqual(expect.arrayContaining([5, 6]))
    expect(trimmed).toHaveLength(2)
  })

  it('protects one newest window per speaker, then trims the rest oldest-first', () => {
    const queue = [job('you', 1), job('them', 2), job('you', 3), job('them', 4), job('you', 5), job('them', 6)]
    const trimmed = trimQueue(queue, 3)
    // Newest 'you' (5) and newest 'them' (6) are protected outright; the oldest THREE (1, 2, 3) are the
    // excess to drop, leaving the next-oldest unprotected window (4) as the third survivor.
    expect(trimmed.map((j) => j.id)).toEqual([4, 5, 6])
  })

  it('is what pushAudio actually calls on backpressure, surfacing DROPPED_MSG', () => {
    expect(listenSrc).toMatch(/queue\.current = trimQueue\(queue\.current, MAX_QUEUE\)/)
    expect(listenSrc).toMatch(/setState\(\(s\) => \(s\.error == null \? \{ \.\.\.s, error: DROPPED_MSG \} : s\)\)/)
  })
})

// ASR quality (1B.2c) — the FIRST language pin gets one more aggressive attempt (lower word-count bar)
// once the opening probe budget is spent with no pin yet, rather than staying wrongly latched to English
// for the rest of a meeting whose opening minute never produced an 8+-word window.
describe('probeMinWords — the first-pin word-count bar relaxes after the opening probe budget (1B.2c)', () => {
  it('uses the normal, stricter bar while still inside the opening probe budget', () => {
    expect(probeMinWords(false, 1)).toBe(8)
    expect(probeMinWords(false, 5)).toBe(8) // PROBE_WINDOW_BUDGET itself — still the strict bar
  })

  it('relaxes to the aggressive bar only once the budget is spent with no pin yet', () => {
    expect(probeMinWords(false, 6)).toBe(5)
    expect(probeMinWords(false, 50)).toBe(5)
  })

  it('never relaxes once a language is already pinned, regardless of window index', () => {
    expect(probeMinWords(true, 1)).toBe(8)
    expect(probeMinWords(true, 50)).toBe(8)
  })
})

// ASR quality (1B.2b) — a provisional "…" placeholder is a UI-only stand-in for a window still decoding;
// it must never reach the recap prompt or a saved transcript. transcriptToText (shared by text() and the
// save paths) is the single chokepoint that filters it out.
describe('provisional lines are excluded from text()/transcriptToText (1B.2b)', () => {
  const line = (speaker: TranscriptLine['speaker'], text: string, t: number, provisional?: true): TranscriptLine => ({
    speaker,
    text,
    t,
    ...(provisional ? { provisional } : {})
  })

  it('drops a still-showing "…" placeholder from the recap/save text', () => {
    const lines: TranscriptLine[] = [
      line('you', 'How is the roadmap looking?', 1),
      line('them', '…', 2, true) // decode still in flight when text() was read
    ]
    expect(transcriptToText(lines)).toBe('YOU: How is the roadmap looking?')
  })

  it('includes the real line once it replaces the placeholder (same identity, no provisional flag)', () => {
    const lines: TranscriptLine[] = [line('you', 'How is the roadmap looking?', 1), line('them', 'On track for Q3.', 2)]
    expect(transcriptToText(lines)).toBe('YOU: How is the roadmap looking?\nTHEM: On track for Q3.')
  })

  it('drops decoded provisional caption text as well as the "…" placeholder', () => {
    const lines: TranscriptLine[] = [
      line('them', 'What is the roadmap?', 1, true),
      line('them', 'What is the roadmap for Europe?', 2)
    ]
    expect(transcriptToText(lines)).toBe('THEM: What is the roadmap for Europe?')
  })
})

// Live auto-language first pin (MQA-235): require SWITCH_AFTER consecutive confirming probes before the
// INITIAL pin — same bar as a mid-meeting switch. A single English greeting on a French call used to latch
// English for the rest of the meeting.
describe('advanceLanguageProbe — live first-pin needs SWITCH_AFTER (MQA-235)', () => {
  it('does not pin on the first confident detection while still unpinned', () => {
    const next = advanceLanguageProbe({
      detected: 'English',
      pinnedLang: null,
      switchRun: null,
      switchAfter: 2
    })
    expect(next).toEqual({
      pinnedLang: null,
      switchRun: { lang: 'English', count: 1 },
      shouldPin: false
    })
  })

  it('pins only after SWITCH_AFTER consecutive confirming detections', () => {
    const first = advanceLanguageProbe({
      detected: 'French',
      pinnedLang: null,
      switchRun: null,
      switchAfter: 2
    })
    const second = advanceLanguageProbe({
      detected: 'French',
      pinnedLang: null,
      switchRun: first.switchRun,
      switchAfter: 2
    })
    expect(second).toEqual({ pinnedLang: 'French', switchRun: null, shouldPin: true })
  })

  it('restarts the run when a different language appears before confirmation', () => {
    const next = advanceLanguageProbe({
      detected: 'Spanish',
      pinnedLang: null,
      switchRun: { lang: 'English', count: 1 },
      switchAfter: 2
    })
    expect(next).toEqual({
      pinnedLang: null,
      switchRun: { lang: 'Spanish', count: 1 },
      shouldPin: false
    })
  })

  it('clears a pending switch run when the current pin is re-confirmed', () => {
    const next = advanceLanguageProbe({
      detected: 'French',
      pinnedLang: 'French',
      switchRun: { lang: 'English', count: 1 },
      switchAfter: 2
    })
    expect(next).toEqual({ pinnedLang: 'French', switchRun: null, shouldPin: false })
  })

  it('re-pins after SWITCH_AFTER consecutive detections of a different language', () => {
    const first = advanceLanguageProbe({
      detected: 'English',
      pinnedLang: 'French',
      switchRun: null,
      switchAfter: 2
    })
    const second = advanceLanguageProbe({
      detected: 'English',
      pinnedLang: 'French',
      switchRun: first.switchRun,
      switchAfter: 2
    })
    expect(second).toEqual({ pinnedLang: 'English', switchRun: null, shouldPin: true })
  })

  it('is what useListen feeds into pinLanguage (source contract)', () => {
    expect(listenSrc).toMatch(/advanceLanguageProbe\(\{/)
    expect(listenSrc).toMatch(/workerRef\.current\?\.postMessage\(\{ type: 'pinLanguage', language: next\.pinnedLang \}\)/)
  })

  it('a mixed window confirms a mid-meeting switch immediately (does not keep the first pin forever)', () => {
    const next = advanceLanguageProbe({
      detected: 'English',
      pinnedLang: 'French',
      switchRun: null,
      switchAfter: 2,
      mixed: true
    })
    expect(next).toEqual({ pinnedLang: 'English', switchRun: null, shouldPin: true })
  })

  it('mixed evidence does not skip SWITCH_AFTER on the first pin', () => {
    const next = advanceLanguageProbe({
      detected: 'English',
      pinnedLang: null,
      switchRun: null,
      switchAfter: 2,
      mixed: true
    })
    expect(next.shouldPin).toBe(false)
    expect(next.pinnedLang).toBeNull()
  })
})

// Echo-defense empty feeds must not count toward the Parakeet/Apple empty-run stall that silent-downgrades
// a healthy session to Whisper.
describe('feedEmptyIsEcho — echo silence is not an ASR stall', () => {
  it('is true only for the explicit echo-drop shape', () => {
    expect(feedEmptyIsEcho({ text: '', echo: true })).toBe(true)
    expect(feedEmptyIsEcho({ text: '', echo: false })).toBe(false)
    expect(feedEmptyIsEcho({ text: 'hello', echo: true })).toBe(false)
    expect(feedEmptyIsEcho({ text: '' })).toBe(false)
    expect(feedEmptyIsEcho('')).toBe(false)
  })

  it('is what the Parakeet/Apple empty-run counters gate on (source contract)', () => {
    expect(listenSrc).toMatch(/if \(feedEmptyIsEcho\(res\)\) \{\s*\n\s*parakeetEmptyRunRef\.current = 0/g)
    expect(listenSrc).toMatch(/if \(res\?\.echo\) \{\s*\n\s*const next = linesRef\.current\.filter/)
  })
})

describe('speakerEmbedResultIsStale — late Whisper labels stay in their meeting', () => {
  it('drops a result after the session epoch changes', () => {
    expect(speakerEmbedResultIsStale(7, 8)).toBe(true)
    expect(speakerEmbedResultIsStale(7, 7)).toBe(false)
  })

  it('guards the actual speakerEmbed continuation before echo removal or name attachment', () => {
    expect(listenSrc).toMatch(
      /\.speakerEmbed\(embedAudio, 'them'\)[\s\S]{0,300}?if \(speakerEmbedResultIsStale\(speakerEpoch, sessionEpochRef\.current\)\) return/
    )
  })
})
