import { describe, expect, it } from 'vitest'
import { PRE_MS, WIN_MS, POST_MS, makeTrainGate, runGates, type TapCandidate } from './gates'
import { embed, rms, synthKeyClick, synthSlam, synthSpeech, synthTap } from './__fixtures__/synth'

const SR = 48000
const TOTAL_MS = PRE_MS + WIN_MS + POST_MS

/** Standard candidate: event embedded at the PRE boundary over a quiet floor. */
function cand(signal: Float32Array, noiseRms = 0.001): TapCandidate {
  const pcm = embed(signal, { sampleRate: SR, noiseRms, totalMs: TOTAL_MS, atMs: PRE_MS })
  return { pcm, sampleRate: SR, floorRms: noiseRms }
}

describe('tap gates', () => {
  it('passes a clean tap', () => {
    const v = runGates(cand(synthTap()))
    expect(v).toMatchObject({ ok: true })
    expect(v.window?.length).toBe(Math.round((WIN_MS / 1000) * SR))
    expect(typeof v.logRms).toBe('number')
  })

  it('pre-quiet: rejects an event that did not emerge from silence', () => {
    // Speech running through the PRE segment (event starts at 0, spills over everything).
    const pcm = embed(synthSpeech(), { sampleRate: SR, noiseRms: 0.001, totalMs: TOTAL_MS, atMs: 0 })
    const v = runGates({ pcm, sampleRate: SR, floorRms: 0.001 })
    expect(v).toEqual({ ok: false, reason: 'pre-quiet' })
  })

  it('attack: rejects a slow swell', () => {
    // A speech syllable starting exactly at the onset boundary: quiet PRE, but ~60 ms rise.
    const v = runGates(cand(synthSpeech()))
    expect(v.ok).toBe(false)
    expect(['attack', 'sustained']).toContain(v.reason)
  })

  it('sustained: rejects anything still ringing after the window', () => {
    const v = runGates(cand(synthSlam({ gain: 0.6 })))
    expect(v.ok).toBe(false)
    expect(['sustained', 'clip']).toContain(v.reason)
  })

  it('clip: rejects a clipped strike', () => {
    const hot = synthTap({ gain: 1.0 })
    for (let i = 0; i < 10; i++) hot[i + 20] = 0.999
    const v = runGates(cand(hot))
    expect(v).toEqual({ ok: false, reason: 'clip' })
  })

  it('key-click: rejects an HF micro-burst', () => {
    const v = runGates(cand(synthKeyClick()))
    expect(v).toEqual({ ok: false, reason: 'key-click' })
  })

  it('level-band: rejects a strike far outside the calibrated loudness range', () => {
    const quiet = runGates(cand(synthTap({ gain: 0.02 })), { min: Math.log(0.05), max: Math.log(0.2) })
    expect(quiet).toEqual({ ok: false, reason: 'level-band' })
    // …and passes inside the band.
    const base = runGates(cand(synthTap()))
    expect(base.ok).toBe(true)
    const inBand = runGates(cand(synthTap()), { min: base.logRms! - 0.1, max: base.logRms! + 0.1 })
    expect(inBand.ok).toBe(true)
  })

  it('level-band is skipped when no calibration range exists yet', () => {
    expect(runGates(cand(synthTap({ gain: 0.02 }))).ok).toBe(true)
  })
})

describe('train gate (typing suppression)', () => {
  it('lets isolated onsets through', () => {
    const g = makeTrainGate()
    expect(g.step(0)).toBe(true)
    expect(g.step(2000)).toBe(true)
    expect(g.step(4000)).toBe(true)
  })

  it('suppresses a typing burst and stays suppressed until quiet', () => {
    const g = makeTrainGate()
    expect(g.step(0)).toBe(true)
    expect(g.step(150)).toBe(true)
    expect(g.step(300)).toBe(false) // 3rd onset within 1 s → train
    expect(g.step(450)).toBe(false)
    expect(g.step(700)).toBe(false) // still inside cooldown, keeps extending
    expect(g.step(2600)).toBe(true) // > 500 ms of quiet → re-armed
  })

  it('reset clears all state', () => {
    const g = makeTrainGate()
    g.step(0)
    g.step(100)
    g.step(200)
    g.reset()
    expect(g.step(210)).toBe(true)
  })
})

describe('fixture sanity', () => {
  it('synthetic tap actually looks like a tap (fast attack, fast decay)', () => {
    const tap = synthTap()
    const early = rms(tap, 0, Math.round(0.02 * SR))
    const late = rms(tap, Math.round(0.06 * SR), tap.length)
    expect(early).toBeGreaterThan(late * 2)
  })
})
