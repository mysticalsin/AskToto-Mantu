import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { makeVad, isSpeechLikeWindow } from './vad'
import { WHISPER_WORKLET_SRC } from './whisper-worklet-src'

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

describe('whisper worklet source', () => {
  it('embeds makeVad + isSpeechLikeWindow and parses as valid JS (guards the .toString() transplant)', () => {
    expect(WHISPER_WORKLET_SRC).toContain('makeVad')
    expect(WHISPER_WORKLET_SRC).toContain('this.vad.step')
    expect(WHISPER_WORKLET_SRC).toContain('isSpeechLikeWindow')
    // Compile the worklet body with the realtime globals stubbed → proves it parses and the embedded
    // makeVad survived intact (a broken transplant would throw a SyntaxError here).
    const compile = (): void =>
      void new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)
    expect(compile).not.toThrow()
  })

  /** Instantiate the ACTUAL worklet source with the realtime globals stubbed, capturing emitted windows. */
  function instantiateWorklet(messages: Array<{ audio?: Float32Array }>): {
    process: (inputs: Float32Array[][]) => boolean
  } {
    let Registered: (new () => { process: (inputs: Float32Array[][]) => boolean }) | null = null
    class FakeProcessor {
      port = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        postMessage: (m: { audio?: Float32Array }): void => void messages.push(m)
      }
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)(
      FakeProcessor,
      (_name: string, cls: new () => { process: (inputs: Float32Array[][]) => boolean }): void =>
        void (Registered = cls),
      SR
    )
    if (!Registered) throw new Error('worklet source registered no processor')
    return new Registered()
  }

  function tone(sec: number, amp: number, hz = 440): Float32Array {
    const n = Math.round(sec * SR)
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
    return buf
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

  function feed(w: { process: (inputs: Float32Array[][]) => boolean }, signal: Float32Array): void {
    for (let o = 0; o + FRAME <= signal.length; o += FRAME) w.process([[signal.subarray(o, o + FRAME)]])
  }

  it('never emits during a steady boosted bed — the 6s hard-cap window is gated out pre-ASR', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    // 6.5s of steady tone at RMS ~0.035: above VAD ON (0.012) and EMIT_RMS (0.005), i.e. exactly the
    // boosted hold-music case. The hard cap fires at 6s; the envelope gate must swallow that window.
    feed(w, tone(6.5, 0.05))
    expect(messages).toHaveLength(0)
  })

  it('delivers a short remote reply buried in a steady boosted bed (MQA-044)', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    // 4s of bed at RMS ~0.009 (a 0.003 far-end bed × the 3.0× them boost), a 0.5s reply, then more bed.
    // Latched, the VAD never end-pointed: the only cut was the 6s hard cap, and that window is ~92% bed,
    // so the envelope gate judged it non-speech and the reply never reached the ASR at all.
    feed(w, concat(tone(4, 0.0127), tone(0.5, 0.113), tone(2, 0.0127)))
    const finals = messages.filter((m) => !(m as { partial?: boolean }).partial)
    expect(finals).toHaveLength(1)
    expect(finals[0].audio!.length).toBeLessThan(6 * SR) // end-pointed, not force-cut at the hard cap
  })

  it('still emits a real utterance: syllabic bursts end-pointed and passed through the gate', () => {
    const messages: Array<{ audio?: Float32Array }> = []
    const w = instantiateWorklet(messages)
    const silence = (sec: number): Float32Array => new Float32Array(Math.round(sec * SR))
    feed(
      w,
      concat(tone(0.4, 0.2), silence(0.2), tone(0.4, 0.2), silence(0.2), tone(0.4, 0.2), silence(0.8))
    )
    const finals = messages.filter((m) => !(m as { partial?: boolean }).partial)
    expect(finals).toHaveLength(1)
    expect(finals[0].audio!.length).toBeGreaterThan(0)
  })
})

// Normalize CRLF → LF (same rationale as listen.test.ts): a Windows checkout would otherwise break any
// anchor whose newline sits mid-string.
const listenSrc = readFileSync(join(__dirname, 'listen.ts'), 'utf8').replace(/\r\n/g, '\n')

// MQA-041 — the same commit that taught the system-audio watcher to retry off capture state on Windows
// left an earlier `isWindows ||` in the effect's own early return, so the interval was never created there
// and the Windows branch inside it was unreachable in every state. A start-time loopback failure (default
// output mid-switch, another app holding the render endpoint) that healed seconds later therefore ran the
// whole meeting mic-only: no 'them' track exists, so no 'ended' event can fire, and the devicechange
// handler only re-acquires the mic. The only recovery left was Stop → Listen, which splits the transcript.
describe('windows system-audio retry watcher (MQA-041)', () => {
  it('creates the interval on Windows — the effect gates on session state only', () => {
    expect(listenSrc).toMatch(/if \(!state\.listening \|\| !wantsSystemRef\.current\) return\n {4}const iv = setInterval/)
    expect(listenSrc).not.toMatch(/if \(isWindows \|\| !state\.listening/)
  })

  it('retries capture directly on Windows instead of polling a permission that never flips', () => {
    // Anchored on the branch's CONTENT, not its exact text: MQA-163 added backoff pacing inside it, and
    // what MQA-041 needs pinned is that the Windows tick re-acquires off capture state and never reaches
    // the permission poll below.
    const branch = listenSrc.match(/\n {6}if \(isWindows\) \{\n([\s\S]*?)\n {6}\}\n {6}void window\.toto/)
    expect(branch).not.toBeNull()
    expect(branch![1]).toContain('void recoverSystemAudioRef.current?.()')
    expect(branch![1]).not.toContain('getPermissions')
    // The macOS path keeps its permission gate — a granted flip is still what resumes 'them' there.
    expect(listenSrc).toMatch(/if \(p\?\.screenRecording === 'granted' && !channels\.current\.them\)/)
  })
})
