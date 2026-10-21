// WP14 sandbox acceptance — synthetic audio for the QA build's file-fed microphone (src/main/qa-capture-source.ts).
// The app feeds Chromium's fake capture device from METIS_QA_CAPTURE_FILE when the build is QA-identity and the WAV is
// inside the ASKTOTO_USERDATA profile, so no real microphone is ever opened. Speech comes from macOS `say`, converted
// to 16 kHz mono 16-bit PCM by `afconvert`; there is deliberately NO silent fallback to a non-speech signal, because a
// tone cannot produce a transcript and that would make the transcript step meaningless.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTool } from './exec.mjs'
import { buildWav, parseWavInfo, sha256Buffer, SYNTHETIC_SCRIPT } from './lib.mjs'

export const AUDIO_KINDS = Object.freeze(['speech', 'tone', 'file'])

/**
 * Write the synthetic capture WAV for a run into `layout.captureWav` (inside the profile) and describe it.
 * @param {{ kind: 'speech' | 'tone' | 'file', layout: { captureDir: string, captureWav: string, tmp: string }, wavSource?: string, run?: typeof runTool }} args
 */
export function prepareAudio({ kind, layout, wavSource, run = runTool }) {
  if (!AUDIO_KINDS.includes(kind)) throw new Error(`unknown audio kind ${JSON.stringify(kind)}`)
  mkdirSync(layout.captureDir, { recursive: true })
  mkdirSync(layout.tmp, { recursive: true })
  if (kind === 'tone') {
    writeFileSync(layout.captureWav, buildWav({ seconds: 20, kind: 'tone-bursts' }))
  } else if (kind === 'file') {
    if (!wavSource) throw new Error('--audio file needs --wav <path>')
    copyFileSync(wavSource, layout.captureWav)
  } else {
    const aiff = join(layout.tmp, 'synthetic-speech.aiff')
    const say = run('/usr/bin/say', ['-o', aiff, '--', SYNTHETIC_SCRIPT], { timeoutMs: 120_000 })
    if (say.status !== 0)
      throw new Error(
        `speech synthesis failed (/usr/bin/say exit ${say.status}${say.error ? `: ${say.error}` : ''}); use --audio file --wav <16-bit PCM wav>`
      )
    const convert = run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, layout.captureWav], {
      timeoutMs: 120_000
    })
    rmSync(aiff, { force: true })
    if (convert.status !== 0)
      throw new Error(`afconvert failed (exit ${convert.status}${convert.error ? `: ${convert.error}` : ''})`)
  }
  const bytes = readFileSync(layout.captureWav)
  const info = parseWavInfo(bytes)
  if (!info) throw new Error('the synthetic capture file is not 16-bit PCM WAV; Chromium fake capture would reject it')
  return {
    kind,
    sha256: sha256Buffer(bytes),
    bytes: bytes.length,
    sampleRate: info.sampleRate,
    channels: info.channels,
    durationSeconds: Math.round(info.durationSeconds * 10) / 10,
    speech: kind === 'speech' || kind === 'file'
  }
}
