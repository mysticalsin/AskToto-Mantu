import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(__dirname, 'listen.ts'), 'utf8')

/**
 * MQA-267 — the 'them' channel was being fed through an echo canceller whose job is to delete it.
 *
 * Both loopback acquisition sites requested bare `getDisplayMedia({ audio: true })`. Probed on real
 * Windows hardware (the setDisplayMediaRequestHandler CAVEAT admitted the path was never validated),
 * the granted track reported echoCancellation:true, noiseSuppression:true, autoGainControl:true.
 *
 * AEC subtracts the far-end audio playing through the speakers — which on a loopback capture IS the
 * signal. With the mic channel open beside it the reference lines up and the other person's speech is
 * partially or wholly cancelled before ASR ever sees it: the main speaker transcribes, the other side
 * intermittently vanishes, the transcript breaks. NS and AGC compound it; both are tuned for a mouth
 * near a microphone, and they pump and gate clean rendered playout.
 *
 * Verified fixed on the shipping Electron build: requesting with the constraints yields a grant with
 * all three processing flags false, applyConstraints holds them false, and the track still carries
 * real audio (peak RMS 0.16 while SAPI speech played through the default output).
 *
 * For the record: the reference implementations the owner pointed at (free-cluely, OpenCluely) never
 * capture system audio at all — both are mic-only. Métis's loopback channel is the stronger design;
 * this was its one wrong default.
 */
describe('MQA-267 — voice processing stays OFF on the loopback, ON on the mic', () => {
  it('declares the loopback constraint set with all three processors disabled', () => {
    const at = SRC.indexOf('const LOOPBACK_AUDIO')
    expect(at).toBeGreaterThan(-1)
    const decl = SRC.slice(at, at + 220)
    expect(decl).toMatch(/echoCancellation: false/)
    expect(decl).toMatch(/noiseSuppression: false/)
    expect(decl).toMatch(/autoGainControl: false/)
  })

  it('every getDisplayMedia call passes the loopback constraints — none requests bare audio', () => {
    // A bare `audio: true` reintroduces the default-on processing this exists to remove.
    expect(SRC).not.toMatch(/getDisplayMedia\(\{ audio: true \}\)/)
    expect(SRC).not.toMatch(/getDisplayMedia\(\{ video: \{ frameRate: 1 \}, audio: true \}\)/)
    // [^)]* not [^}]* — the video-bound form is `{ video: { frameRate: 1 }, audio: LOOPBACK_AUDIO }`,
    // and a character class stopping at the first `}` never reaches its audio key.
    const calls = SRC.match(/getDisplayMedia\(\{[^)]*audio: LOOPBACK_AUDIO/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(3)
  })

  it('acquisition flows through the single acquireLoopback helper at both call sites', () => {
    // Two sites drifted apart once already (the recovery path predates the start path). One helper
    // means the next constraint change cannot half-land.
    const uses = SRC.match(/await acquireLoopback\(\)/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(2)
  })

  it('re-applies the constraints to the LIVE track after the grant', () => {
    // getDisplayMedia audio constraints are not reliably honored across Chromium versions;
    // applyConstraints on the live track is the belt-and-braces that holds either way.
    expect(SRC).toMatch(/applyConstraints\(LOOPBACK_AUDIO\)/)
    // A track that refuses must not fail the capture — degraded beats absent.
    expect(SRC).toMatch(/a processed 'them' is still better than none/)
  })

  it('the MIC keeps echo cancellation — the asymmetry is the design', () => {
    // AEC on the mic is what stops the speakers bleeding the other person's words into the 'you'
    // channel as duplicates. Removing it there "for symmetry" recreates the opposite corruption.
    const mic = SRC.slice(SRC.indexOf('async function acquireMic'), SRC.indexOf('async function acquireMic') + 400)
    expect(mic).toMatch(/echoCancellation: true/)
  })

  it('acquireLoopback never stops a track — the macOS SCStream contract holds', () => {
    // Stopping the bound video track before the worklet connects kills the shared SCStream and leaves
    // the audio track 'ended' but present. closeChannel owns the stop, at Listen end.
    const fn = SRC.slice(SRC.indexOf('async function acquireLoopback'), SRC.indexOf('export function useListen'))
    expect(fn).not.toMatch(/\.stop\(\)/)
  })
})
