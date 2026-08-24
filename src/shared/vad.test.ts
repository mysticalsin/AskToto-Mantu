import { describe, it, expect } from 'vitest'
import { makeVad, isSpeechLikeWindow, vadWindowsFromPcm } from './vad'

const SR = 16000
const FRAME = 128 // one AudioWorklet quantum
const SPEECH = 0.08 // RMS of clear speech (above the 0.012 ON threshold)
const SILENCE = 0.001 // RMS of a quiet room (below the 0.006 OFF threshold)
const frames = (seconds: number): number => Math.round((seconds * SR) / FRAME)

/** Drive the VAD the way the worklet does (track buffer fill, reset on emit) and record each emit. */
function run(segments: Array<{ rms: number; sec: number }>): Array<{ speechSec: number; sinceResetSec: number }> {
  const vad = makeVad()
  const emits: Array<{ speechSec: number; sinceResetSec: number }> = []
  let samplesSinceReset = 0
  for (const seg of segments) {
    for (let i = 0; i < frames(seg.sec); i++) {
      samplesSinceReset += FRAME
      if (vad.step(seg.rms, FRAME)) {
        emits.push({ speechSec: 0, sinceResetSec: samplesSinceReset / SR })
        vad.reset()
        samplesSinceReset = 0
      }
    }
  }
  return emits
}

// Ported verbatim from src/renderer/src/lib/vad.test.ts (MQA-044 makeVad + isSpeechLikeWindow coverage) —
// vad.ts there is now a thin re-export of this module, so both suites exercise the same implementation.
describe('makeVad — voice-activity endpointing', () => {
  it('emits once, ~0.6s after a real utterance ends', () => {
    const emits = run([
      { rms: SPEECH, sec: 1.2 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(1)
    // 1.2s speech + ~0.6s of trailing silence before the endpoint fires.
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(1.2 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(1.2 + 0.75)
  })

  it('rejects a short transient (cough/click) — under the min-speech floor → no emit', () => {
    const emits = run([
      { rms: SPEECH, sec: 0.15 }, // < 0.3s real speech
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(0)
  })

  it('does NOT cut a sentence on short inter-word gaps', () => {
    // Three speech bursts separated by 0.3s gaps (< the 0.6s endpoint), then a real 1s pause.
    const emits = run([
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 0.3 },
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 0.3 },
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(1) // only the final 0.6s+ silence ends the turn
  })

  it('emits separate windows for two distinct turns', () => {
    const emits = run([
      { rms: SPEECH, sec: 0.6 },
      { rms: SILENCE, sec: 1.0 }, // turn 1 ends
      { rms: SPEECH, sec: 0.6 },
      { rms: SILENCE, sec: 1.0 } // turn 2 ends
    ])
    expect(emits).toHaveLength(2)
  })

  it('never emits on pure silence (no speech ever)', () => {
    const emits = run([{ rms: SILENCE, sec: 10 }])
    expect(emits).toHaveLength(0)
  })

  it('hysteresis: a value between OFF and ON does not start a turn on its own', () => {
    // 0.009 is above OFF (0.006) but below ON (0.012) → must NOT enter the speech state.
    const emits = run([
      { rms: 0.009, sec: 1.0 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(0)
  })

  // MQA-044 — the 'them' channel is boosted 3.0× (listen.ts) to lift un-AGC'd call speech over the fixed
  // thresholds, which also lifts a steady far-end bed (conference comfort noise, hold music, a fan) to or
  // above the 0.006 exit. Once real speech had set the speech flag, the bed kept it set: `silence` was
  // zeroed every quantum, the endpoint could never fire, and the remote side reached the ASR only when the
  // worklet's 6s hard cap force-cut it — mid-word, up to 6s after the question ended.
  it('endpoints a remote turn riding a steady boosted bed (MQA-044)', () => {
    const BED = 0.009 // a 0.003 far-end bed × the 3.0× boost: above the 0.006 exit, below the 0.012 entry
    const emits = run([
      { rms: BED, sec: 2 },
      { rms: SPEECH, sec: 1.2 },
      { rms: BED, sec: 3 }
    ])
    expect(emits).toHaveLength(1) // latched, the bed produced no endpoint at all — ever
    // The turn ends 3.2s in; the endpoint must follow it, not a 6s buffer boundary.
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(3.2 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(3.2 + 1.0)
  })

  it('escapes the speech state when the bed itself rides above the entry threshold (MQA-044)', () => {
    const LOUD_BED = 0.015 // above ON, so the VAD latches on the bed alone before anyone has spoken
    const emits = run([
      { rms: LOUD_BED, sec: 4 },
      { rms: SPEECH, sec: 1.2 },
      { rms: LOUD_BED, sec: 3 }
    ])
    expect(emits).toHaveLength(1)
    expect(emits[0].sinceResetSec).toBeGreaterThan(5.2) // after the turn ended, not part-way through it
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(6.5)
  })

  it('leaves a quiet-room turn exactly where it was (the adaptive floor stays out of the way)', () => {
    // The mic channel never carries a bed above the absolute floor, so nothing about its endpointing may
    // move: same single emit, same ~0.6s trailing silence as before the floor existed.
    const emits = run([
      { rms: 0.0005, sec: 2 },
      { rms: SPEECH, sec: 2.5 },
      { rms: SILENCE, sec: 1.5 }
    ])
    expect(emits).toHaveLength(1)
    expect(emits[0].sinceResetSec).toBeGreaterThanOrEqual(4.5 + 0.58)
    expect(emits[0].sinceResetSec).toBeLessThanOrEqual(4.5 + 0.75)
  })

  it('reset() clears state so the next turn starts fresh', () => {
    const vad = makeVad()
    for (let i = 0; i < frames(0.5); i++) vad.step(SPEECH, FRAME)
    vad.reset()
    // After reset, a brief transient + silence must not emit (speech counter was cleared).
    let emitted = false
    for (let i = 0; i < frames(0.15); i++) emitted ||= vad.step(SPEECH, FRAME)
    for (let i = 0; i < frames(1.0); i++) emitted ||= vad.step(SILENCE, FRAME)
    expect(emitted).toBe(false)
  })
})

/** Build a zero-mean buffer from per-segment RMS levels: samples alternate ±rms (exact RMS, exact mean 0),
 *  optionally riding a DC pedestal to simulate a loopback driver offset. */
function envelope(segments: Array<{ rms: number; sec: number }>, dc = 0): Float32Array {
  const total = segments.reduce((s, seg) => s + Math.round(seg.sec * SR), 0)
  const buf = new Float32Array(total)
  let o = 0
  for (const seg of segments) {
    const n = Math.round(seg.sec * SR)
    for (let i = 0; i < n; i++) buf[o++] = dc + (i % 2 === 0 ? seg.rms : -seg.rms)
  }
  return buf
}

describe('isSpeechLikeWindow — steady-background gate (them-channel boost fallout)', () => {
  const BED = { rms: 0.03, sec: 3 } // steady bed at ~2.5× the VAD ON threshold — what the 3.0× boost produces

  it('drops a steady bed (hold music / fan): flat envelope, no syllabic spread', () => {
    expect(isSpeechLikeWindow(envelope([BED]), Math.round(BED.sec * SR))).toBe(false)
  })

  it('drops a gently wobbling bed (±1.6 dB stays far under the 8 dB speech spread)', () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({ rms: i % 2 === 0 ? 0.025 : 0.03, sec: 0.1 }))
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(false)
  })

  it('keeps speech: syllabic bursts with near-silent gaps', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 },
      { rms: 0.001, sec: 0.2 }
    ])
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('keeps speech over a loud music bed (peaks ≥ 8 dB above the bed)', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 }, // speech peaks
      { rms: 0.02, sec: 0.2 } // bed shows through in the gaps
    ])
    const buf = envelope(segs)
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('keeps a short reply that fills under a tenth of a bed-dominated window (MQA-044)', () => {
    // A bed emits nothing on its own, so the window that finally closes around a brief remote reply opened
    // seconds earlier and is ~90% bed. The p90 frame then lands on the bed, the ratio reads ~1, and the
    // real utterance was dropped with the window it arrived in.
    const buf = envelope([
      { rms: 0.009, sec: 4 },
      { rms: 0.08, sec: 0.5 }, // "Sure." — 10 of the window's 102 frames
      { rms: 0.009, sec: 0.6 }
    ])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('a lone transient over a bed is still not enough to pass (no run, no speech)', () => {
    const buf = envelope([
      { rms: 0.009, sec: 4 },
      { rms: 0.08, sec: 0.1 }, // click/keystroke: 2 frames, under the 0.3s held-speech floor
      { rms: 0.009, sec: 0.6 }
    ])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(false)
  })

  it('fails open on windows too short to judge (< 0.4s)', () => {
    const buf = envelope([{ rms: 0.03, sec: 0.3 }])
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })

  it('is scale-invariant: the 3.0× channel gain cannot change the verdict', () => {
    const bed = envelope([BED])
    const speech = envelope([0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 },
      { rms: 0.001, sec: 0.2 }
    ]))
    const boost = (b: Float32Array): Float32Array => b.map((v) => v * 3)
    expect(isSpeechLikeWindow(boost(bed), bed.length)).toBe(false)
    expect(isSpeechLikeWindow(boost(speech), speech.length)).toBe(true)
  })

  it('a DC offset does not compress the spread against real speech (mean-removed RMS)', () => {
    const segs = [0, 0, 0, 0].flatMap(() => [
      { rms: 0.08, sec: 0.4 },
      { rms: 0.001, sec: 0.2 }
    ])
    const buf = envelope(segs, 0.5) // raw frame RMS would be ~0.5 everywhere → ratio ~1 → speech eaten
    expect(isSpeechLikeWindow(buf, buf.length)).toBe(true)
  })
})

// --- vadWindowsFromPcm — the batch counterpart ------------------------------------------------------------

/** Synthesize a 16kHz sine burst (real speech-band signal, not the ±rms square wave `envelope` uses —
 *  vadWindowsFromPcm's own frameRms/isSpeechLikeWindow gates should treat either shape as speech). */
function sineBurst(sec: number, amp: number, hz = 220): Float32Array {
  const n = Math.round(sec * SR)
  const buf = new Float32Array(n)
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return buf
}

function silence(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SR))
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('vadWindowsFromPcm — batch VAD windowing', () => {
  it('silence-only yields no windows', () => {
    expect(vadWindowsFromPcm(silence(5), SR)).toEqual([])
  })

  it('two speech bursts separated by a 1s gap yield two non-overlapping windows', () => {
    // Each burst is followed by enough trailing silence (1s > the 0.6s endpoint) to close its own window.
    const pcm = concat(sineBurst(0.6, 0.3), silence(1.0), sineBurst(0.6, 0.3), silence(1.0))
    const windows = vadWindowsFromPcm(pcm, SR)
    expect(windows).toHaveLength(2)
    // Windows never overlap, and stay in buffer order.
    expect(windows[0].end).toBeLessThanOrEqual(windows[1].start)
    // Each window is tight around its burst (± the 0.15s pad), not the whole 1s silent gap either side.
    const dur = (w: { start: number; end: number }): number => (w.end - w.start) / SR
    expect(dur(windows[0])).toBeGreaterThanOrEqual(0.6)
    expect(dur(windows[0])).toBeLessThan(1.2)
    expect(dur(windows[1])).toBeGreaterThanOrEqual(0.6)
    expect(dur(windows[1])).toBeLessThan(1.2)
    // Second burst's real content starts at 1.6s into the buffer; padded start sits ~0.15s ahead of that,
    // not back near the middle of the 1s silent gap (which would mean the pad/trim step isn't working).
    expect(windows[1].start / SR).toBeGreaterThan(1.4)
    expect(windows[1].start / SR).toBeLessThan(1.6)
  })

  it('a burst longer than maxWindowSec splits at the cap', () => {
    // A continuous unmodulated tone reads as a steady non-speech bed to isSpeechLikeWindow (no envelope
    // spread), same as real hold music would — so this needs an actually speech-shaped signal: the same
    // syllabic burst/gap rhythm as the ported "does NOT cut a sentence on short inter-word gaps" makeVad
    // test above (0.5s speech / 0.3s gap, gap well under the 0.6s endpoint so the VAD never naturally
    // closes), just repeated long enough to run past the 15s cap. Only the hard cap can split this — same
    // one long "sentence" the live worklet would force-cut at its 6s cap.
    const units = Array.from({ length: 24 }, () => [
      { rms: SPEECH, sec: 0.5 },
      { rms: SILENCE, sec: 0.3 }
    ]).flat()
    const pcm = envelope([...units, { rms: SILENCE, sec: 1.0 }]) // trailing silence closes out the remainder
    const windows = vadWindowsFromPcm(pcm, SR, { maxWindowSec: 15 })
    expect(windows.length).toBeGreaterThanOrEqual(2)
    // The split lands at (approximately) the 15s cap — up to one 8ms quantum past it, since the cap only
    // fires once accumulated fill reaches it — and the two halves never overlap.
    expect(windows[0].end / SR).toBeGreaterThan(14.5)
    expect(windows[0].end / SR).toBeLessThanOrEqual(15.05)
    expect(windows[1].start).toBeGreaterThanOrEqual(windows[0].end)
  })

  it('applies pre/post padding around an isolated burst', () => {
    const leadSilence = 2.0
    const burstSec = 0.6
    const full = concat(silence(leadSilence), sineBurst(burstSec, 0.3), silence(2.0))
    const windows = vadWindowsFromPcm(full, SR)
    expect(windows).toHaveLength(1)
    const burstStart = leadSilence * SR
    const burstEnd = (leadSilence + burstSec) * SR
    // Padded start/end sit ~0.15s outside the actual burst (generous tolerance for the 10ms trim scan and
    // the VAD's own onset lag), and strictly inside the raw burst bounds without any pad at all.
    expect(windows[0].start).toBeLessThan(burstStart)
    expect(windows[0].start).toBeGreaterThan(burstStart - SR * 0.3)
    expect(windows[0].end).toBeGreaterThan(burstEnd)
    expect(windows[0].end).toBeLessThan(burstEnd + SR * 0.3)
  })

  it('existing makeVad behavior is untouched by the batch addition', () => {
    // Same assertion as the very first makeVad test above, re-run after vadWindowsFromPcm has been defined
    // in the same module — guards against the batch code mutating any shared/module-level state.
    const emits = run([
      { rms: SPEECH, sec: 1.2 },
      { rms: SILENCE, sec: 1.0 }
    ])
    expect(emits).toHaveLength(1)
  })
})
