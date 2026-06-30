import { describe, it, expect } from 'vitest'
import { makeVad } from './vad'
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

describe('whisper worklet source', () => {
  it('embeds makeVad and parses as valid JS (guards the .toString() transplant)', () => {
    expect(WHISPER_WORKLET_SRC).toContain('makeVad')
    expect(WHISPER_WORKLET_SRC).toContain('this.vad.step')
    // Compile the worklet body with the realtime globals stubbed → proves it parses and the embedded
    // makeVad survived intact (a broken transplant would throw a SyntaxError here).
    const compile = (): void =>
      void new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', WHISPER_WORKLET_SRC)
    expect(compile).not.toThrow()
  })
})
