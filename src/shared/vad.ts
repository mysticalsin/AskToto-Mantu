/**
 * Voice-activity endpointing for the live-transcription worklet.
 *
 * Written as a pure, self-contained factory for ONE reason: the exact same logic is both unit-tested
 * (vad.test.ts) AND embedded into the AudioWorklet source string (whisper-worklet-src.ts) via
 * `makeVad.toString()`. One definition → zero drift between the tested code and the code that actually runs
 * on the audio thread. It must reference nothing outside itself (only `Math` + literals), so it transplants
 * cleanly into the realtime worklet global scope.
 *
 * Decision: emit the window when there has been enough REAL speech (rejects coughs/clicks) followed by a
 * continuous trailing silence (end of turn). Hysteresis (ON > OFF) keeps the speech flag from flickering at
 * the threshold; per-word gaps are far shorter than the endpoint, so they never cut a sentence early.
 *
 * Lives in `src/shared` (not `src/renderer`) so the same state machine drives two consumers: the realtime
 * worklet (`src/renderer/src/lib/whisper-worklet-src.ts`, via `makeVad.toString()`, one quantum at a time)
 * and the batch import path (`vadWindowsFromPcm` below, the whole file at once, no `.toString()` transplant
 * needed since main-process code just imports it directly). `src/renderer/src/lib/vad.ts` re-exports this
 * module so the worklet transplant and every renderer import keep working unchanged.
 */
/**
 * Window-level speech-likeness gate, applied at emit time (after the whole-window RMS floor).
 *
 * Why it exists: the 'them' channel boosts quiet system-loopback 3.0× to lift un-AGC'd call speech over
 * the fixed VAD/EMIT thresholds — but that boost also lifts steady background sound (hold music, a fan,
 * street noise) above them, so during quiet stretches the VAD never leaves the speech state and the 6s
 * hard cap force-emits non-speech windows to the ASR continuously. Whisper hallucinates captions on
 * exactly those windows, and text-side phantom/repetition filters only catch some of the fallout.
 *
 * The discriminator is temporal envelope spread, not spectral flatness or model no-speech probability:
 * speech carries 3–8 Hz syllabic modulation, so its 50ms-frame RMS spans ≥8 dB (inter-word/syllable dips)
 * even over a loud music bed, while a steady bed stays within ~3 dB. Spectral flatness can't make this
 * cut (music is tonal — low flatness, the same side as speech), and Whisper's no_speech_prob is neither
 * exposed by the transformers.js pipeline() API nor on the Apple-ASR path at all. A p90/p10 RMS ratio is
 * also scale-invariant, so the 3.0× channel gain cancels exactly — one threshold serves both channels.
 *
 * Fail-open by design: windows too short to judge pass, borderline ratios pass, and a bed that STOPS
 * mid-window (its trailing endpoint silence widens the ratio) passes — one leaked window per music-stop
 * beats eating short steady vocalizations ("mmm", a held "yes"). Downstream text filters stay as backstop.
 *
 * Same transplant contract as makeVad: pure, self-contained (Math + literals only), embedded into the
 * AudioWorklet source string via `.toString()` and unit-tested here as ONE definition.
 */
export function isSpeechLikeWindow(buf: Float32Array, n: number): boolean {
  const FRAME = 800 // 50ms @ 16kHz — syllable-scale envelope resolution
  const MIN_FRAMES = 8 // < 0.4s of audio → too little envelope to judge; fail open
  const SPREAD = 2.5 // p90/p10 frame-RMS ratio (~8 dB): speech exceeds it, a steady bed never does
  const RUN_FRAMES = 6 // 0.3s held above the bed = real speech (the same floor makeVad endpoints on)
  const m = Math.floor(n / FRAME)
  if (m < MIN_FRAMES) return true
  const rms: number[] = []
  for (let f = 0; f < m; f++) {
    let sum = 0
    let sq = 0
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
      const v = buf[i]
      sum += v
      sq += v * v
    }
    // Mean-removed RMS: a loopback driver's DC offset would otherwise inflate every frame equally and
    // compress the spread toward 1, silently turning the gate against real speech.
    const mean = sum / FRAME
    rms.push(Math.sqrt(Math.max(0, sq / FRAME - mean * mean)))
  }
  const sorted = rms.slice().sort((a, b) => a - b) // order statistics on a copy; the run scan below needs time order
  const lo = sorted[Math.floor(m * 0.1)]
  const hi = sorted[Math.floor(m * 0.9)]
  if (hi < 1e-6) return true // effectively silent — the emit-side RMS floor owns that case
  if (hi / Math.max(lo, 1e-6) >= SPREAD) return true
  // p90/p10 asks whether the window is MOSTLY modulated, which a brief remote reply cannot be: a window
  // that opened seconds before the far end spoke (a bed emits nothing, so the buffer runs to the endpoint
  // or the 6s cap) is >90% bed, the p90 frame lands on the bed, and the ratio judges the whole window —
  // real utterance included — non-speech. A sustained run above the bed is speech no matter how little of
  // the window it fills; a steady bed has no such run by definition, so this cannot readmit one.
  const gate = Math.max(lo, 1e-6) * SPREAD
  let held = 0
  for (let f = 0; f < m; f++) {
    held = rms[f] >= gate ? held + 1 : 0
    if (held >= RUN_FRAMES) return true
  }
  return false
}

export function makeVad(): { step: (rms: number, n: number) => boolean; reset: () => void } {
  const SR = 16000
  const ENDPOINT = Math.round(SR * 0.6) // continuous trailing silence that ends a turn (~0.6s). Tuned for
  // low turn-detection latency: still 2× a typical inter-word gap (~0.3s) so it never cuts mid-sentence,
  // but ~0.2s snappier than a conservative 0.8s — the dominant slice of perceived live-caption lag.
  const MIN_SPEECH = Math.round(SR * 0.3) // real speech needed in-window before we'll endpoint (rejects transients)
  const ON = 0.012 // per-quantum RMS to ENTER the speech state
  const OFF = 0.006 // per-quantum RMS to EXIT it (ON > OFF = hysteresis, no flicker at the boundary)
  // ON/OFF are the FLOOR of an adaptive pair, not the whole rule. Absolute alone, the exit cannot end a
  // turn on the 3.0×-boosted 'them' channel: a far-end bed (conference comfort noise, hold music, a fan)
  // lands at or above OFF, so once real speech has set the flag every quantum keeps it set, `silence` is
  // zeroed forever, and the endpoint below can never fire — remote turns were cut only by the worklet's 6s
  // hard cap (up to 6s of turn-detection lag, sentences sliced mid-word). Scaling by a tracked noise floor
  // makes the exit mean "back down to the room", which is what the end of a turn physically is.
  const OFF_K = 1.4 // exit 1.4× above the floor — clear of a steady bed's own quantum-to-quantum ripple
  const ON_K = 2.0 // enter 6dB above it, so hysteresis survives at every floor level (ON_K > OFF_K)
  // The floor must estimate the BED and never the voice. It tracks freely while the VAD is idle (down fast
  // so a bed that stops is forgotten within ~0.2s, up over ~0.8s so it settles between turns) but is held
  // to a ~10s creep while the speech state is set: otherwise a monologue drags the floor up to its own
  // level and endpoints itself mid-sentence. That creep is also the only way out of a bed already above ON
  // when capture started — the VAD latches on the bed itself there, so the idle path never gets to run.
  const UP_IDLE = 1.25 // per second
  const DOWN_IDLE = 6
  const UP_HELD = 0.1
  let floor = 0
  let active = false
  let silence = 0
  let speech = 0
  return {
    // Feed one quantum (its RMS + sample count). Returns true when the window should be emitted now.
    step(rms, n) {
      const rate = active ? (rms > floor ? UP_HELD : 0) : rms > floor ? UP_IDLE : DOWN_IDLE
      floor += (rms - floor) * Math.min(1, (n / SR) * rate) // clamped: one long quantum must not overshoot
      const off = Math.max(OFF, floor * OFF_K)
      const on = Math.max(ON, floor * ON_K)
      if (active) {
        if (rms < off) active = false
      } else if (rms >= on) {
        active = true
      }
      if (active) {
        speech += n
        silence = 0
      } else {
        silence += n
      }
      return speech >= MIN_SPEECH && silence >= ENDPOINT
    },
    reset() {
      // `floor` deliberately survives: it describes the channel's background, not the turn. The worklet
      // resets on every emit, so re-learning it each window would re-latch on the bed once per window.
      active = false
      silence = 0
      speech = 0
    }
  }
}

/** One speech window from `vadWindowsFromPcm`, as sample offsets into the source PCM buffer. */
export interface VadWindow {
  start: number
  end: number
}

// Raw window before trim/pad/merge — carries whether it was force-closed by the hard cap, because that
// boundary must never be re-merged (see the merge step below), including a short selected pause.
interface RawWindow extends VadWindow {
  capped: boolean
}

/**
 * Batch counterpart to `makeVad`: runs the identical frame-by-frame state machine over a whole PCM buffer
 * in one call, for the main-process import path (a decoded file, not a live mic stream) instead of one
 * AudioWorklet quantum at a time.
 *
 * Uses the live VAD's RMS endpointing and the same two post-hoc gates (`EMIT_RMS` whole-window floor,
 * `isSpeechLikeWindow` envelope gate). Batch-only cap placement, trimming and padding do not alter
 * makeVad or the live worklet's latency.
 *
 * Differences, all deliberate for batch:
 *  - `maxWindowSec` defaults to 15s, not the live 6s. The live cap exists to bound turn-detection latency —
 *    never make a caption wait behind a long monologue. Batch has no latency budget, so a bigger cap trades
 *    that away for fewer boundaries: every boundary is a place a batch ASR model can lose sentence context,
 *    and batch models (unlike the realtime path) comfortably transcribe a 15s utterance in one pass.
 *  - MQA-309: before a hard cap, a bounded lookahead prefers a genuine short pause to cutting active
 *    speech mid-word/number. No qualifying pause means the exact hard limit. This changes batch window
 *    indices: callers must version durable checkpoints rather than reusing old window cursors.
 *  - Each kept window gets a small pre/post pad (default 0.15s), and nearby natural windows are merged
 *    only when their combined length stays under the cap. Padding shares each gap at one midpoint, so
 *    padded windows never overlap. The live path has no such step: it hands the worklet's raw,
 *    unpadded, unmerged buffer straight to the ASR because it only ever sees one window at a time and can't
 *    look ahead to a future one to merge with.
 */
export function vadWindowsFromPcm(
  pcm: Float32Array,
  sampleRate: number,
  opts?: { maxWindowSec?: number }
): VadWindow[] {
  const QUANTUM = 128 // one Web Audio render quantum — identical granularity to the live worklet
  const EMIT_RMS = 0.005 // whole-window energy floor below which Whisper hallucinates (same as the worklet)
  const PAD_SEC = 0.15 // pre/post pad so consonant onsets/codas aren't clipped at a trimmed endpoint boundary
  const MERGE_GAP_SEC = 0.3 // nearby natural windows may merge if their combined length stays under the cap
  const TRIM_FRAME_SEC = 0.01 // 10ms scan step for trimming each kept window down to its real speech extent
  const PAUSE_RMS = 0.003 // stricter than the trim floor: quiet, not merely a softer syllable
  const MIN_PAUSE_SEC = 0.12 // ignore brief stop-consonant/inter-syllable dips
  const maxWindowSec = opts?.maxWindowSec ?? 15
  const maxSamples = Math.max(1, Math.round(sampleRate * maxWindowSec))
  const pad = Math.round(sampleRate * PAD_SEC)
  const mergeGap = Math.round(sampleRate * MERGE_GAP_SEC)
  const trimFrame = Math.max(1, Math.round(sampleRate * TRIM_FRAME_SEC))
  const minPause = Math.max(1, Math.round(sampleRate * MIN_PAUSE_SEC))
  const lookback = Math.min(Math.round(sampleRate * 3), Math.floor(maxSamples / 4))

  const frameRms = (start: number, end: number): number => {
    let sq = 0
    for (let i = start; i < end; i++) {
      const v = pcm[i]
      sq += v * v
    }
    return Math.sqrt(sq / Math.max(1, end - start))
  }

  const pauseBeforeCap = (hardEnd: number): number => {
    let quietStart: number | null = null
    let preferred = hardEnd
    const keepPause = (end: number): void => {
      if (quietStart !== null && end - quietStart >= minPause) {
        preferred = Math.floor((quietStart + end) / 2)
      }
    }
    for (let start = hardEnd - lookback; start < hardEnd; start += trimFrame) {
      const end = Math.min(start + trimFrame, hardEnd)
      if (frameRms(start, end) < PAUSE_RMS) {
        if (quietStart === null) quietStart = start
      } else {
        keepPause(start)
        quietStart = null
      }
    }
    keepPause(hardEnd)
    return preferred
  }

  // --- 1. Walk the buffer one quantum at a time, driving the same VAD used live, and collect raw windows.
  const vad = makeVad()
  const raw: RawWindow[] = []
  let winStart = 0
  let fill = 0
  let capEnd = Math.min(maxSamples, pcm.length)
  let capChosen = capEnd === pcm.length

  const emitRaw = (capped: boolean): void => {
    const n = fill
    const start = winStart
    fill = 0
    winStart = start + n
    vad.reset()
    capEnd = Math.min(winStart + maxSamples, pcm.length)
    capChosen = capEnd === pcm.length
    if (n === 0) return
    if (frameRms(start, start + n) < EMIT_RMS) return // silent window — drop, same floor as the worklet
    if (!isSpeechLikeWindow(pcm.subarray(start, start + n), n)) return // steady non-speech bed — drop
    raw.push({ start, end: start + n, capped })
  }

  let offset = 0
  while (offset < pcm.length) {
    // Do the small lookahead only for utterances that actually approach the cap. Short natural turns
    // pay no extra PCM scan. Choose before consuming this tail: no rewind or duplicated samples.
    if (!capChosen && offset >= capEnd - lookback) {
      capEnd = pauseBeforeCap(capEnd)
      capChosen = true
    }
    const take = Math.min(QUANTUM, capEnd - offset, capChosen ? Infinity : capEnd - lookback - offset)
    const rms = frameRms(offset, offset + take)
    fill += take
    offset += take
    const endpoint = vad.step(rms, take)
    if (offset === capEnd) emitRaw(offset < pcm.length || fill >= maxSamples)
    else if (endpoint) emitRaw(false)
  }
  emitRaw(false) // flush whatever's left, same as the worklet's 'flush' message on stop()

  if (raw.length === 0) return []

  // --- 2. Trim each kept raw window down to where the actual signal is: the raw span still includes the
  // ENDPOINT dwell (~0.6s of near-silence trailing every natural close) and any leading silence carried
  // over from the previous window's cutoff, neither of which is real content.
  const trimmed = raw.map((w) => {
    let s = w.start
    while (s + trimFrame <= w.end && frameRms(s, s + trimFrame) < EMIT_RMS) s += trimFrame
    let e = w.end
    while (e - trimFrame >= s && frameRms(e - trimFrame, e) < EMIT_RMS) e -= trimFrame
    return { start: s, end: Math.max(s, e), capped: w.capped }
  })

  // --- 3. Merge windows separated by only a short trimmed silence gap — EXCEPT across a hard-cap boundary,
  // which must stay split (that's the whole point of maxWindowSec), even across a short selected pause.
  const core: RawWindow[] = [trimmed[0]]
  for (let i = 1; i < trimmed.length; i++) {
    const prev = core[core.length - 1]
    const cur = trimmed[i]
    if (!prev.capped && cur.start - prev.end <= mergeGap && cur.end - prev.start <= maxSamples) {
      prev.end = cur.end
      prev.capped = cur.capped
    } else {
      core.push(cur)
    }
  }

  // --- 4. Divide a short gap at ONE shared midpoint. A pause-aware cap can preserve a gap shorter than
  // 2×pad; independently padding toward each neighbor's raw edge would overlap and duplicate audio.
  // Padding may use only the space left under maxSamples, never truncate the speech core to make room.
  return core.map((w, i) => {
    const leftBound = i === 0 ? 0 : Math.floor((core[i - 1].end + w.start) / 2)
    const rightBound = i === core.length - 1 ? pcm.length : Math.floor((w.end + core[i + 1].start) / 2)
    const wantBefore = Math.min(pad, w.start - leftBound)
    const wantAfter = Math.min(pad, rightBound - w.end)
    const room = maxSamples - (w.end - w.start)
    const after = Math.min(wantAfter, room - Math.min(wantBefore, Math.floor(room / 2)))
    const before = Math.min(wantBefore, room - after)
    return {
      start: w.start - before,
      end: w.end + after
    }
  })
}
