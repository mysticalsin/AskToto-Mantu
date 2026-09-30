#!/usr/bin/env node
/**
 * Writes the WAV the QA-identity file-fed capture source plays as the microphone (src/main/qa-capture-source.ts):
 * the synthetic English sentences of scripts/qa/asr-fixtures/manifest.json, spoken by /usr/bin/say and
 * converted by /usr/bin/afconvert, with silent pauses between them. macOS only.
 *
 * The file is 16-bit PCM mono at CAPTURE_SAMPLE_RATE (Chromium's fake capture device resamples whatever it
 * is given; 48 kHz is the rate its own capture pipeline runs at) and is MIN_SECONDS..MAX_SECONDS long.
 *
 * Usage: node scripts/qa/meeting/capture-wav.mjs <profile-dir>
 * Prints only the WAV's sha256 and duration. The sentences never reach stdout.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAPTURE_SAMPLE_RATE = 48_000
export const CAPTURE_WAV_NAME = 'qa-capture.wav'
export const MIN_SECONDS = 60
export const MAX_SECONDS = 180
/** Silence after every sentence, so the VAD closes each utterance into its own transcript line. */
export const PAUSE_SECONDS = 4

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), '..', 'asr-fixtures', 'manifest.json')

/** The expected text of every English fixture clip, in manifest order. */
export function englishSentences(manifestPath = MANIFEST) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return manifest.clips.filter((clip) => clip.lang === 'en').map((clip) => clip.expected)
}

/** `say` writes AIFF; the text follows `--` so a sentence can never be read as an option. */
export const sayArgs = (text, aiffPath) => ['-o', aiffPath, '--', text]

/** `afconvert` turns the AIFF into little-endian 16-bit PCM mono WAV at the capture rate. */
export const afconvertArgs = (aiffPath, wavPath) => [
  '-f',
  'WAVE',
  '-d',
  `LEI16@${CAPTURE_SAMPLE_RATE}`,
  '-c',
  '1',
  aiffPath,
  wavPath
]

/** The PCM payload of a WAV, found by walking its chunks (afconvert may add chunks before `data`). */
export function pcmOf(wav) {
  if (wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('latin1', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') return wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size))
    offset += 8 + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

export function wavFromPcm(pcm, sampleRate = CAPTURE_SAMPLE_RATE) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function defaultRun(command, args) {
  execFileSync(command, args, { stdio: 'ignore' })
}

const secondsOf = (pcm) => pcm.length / 2 / CAPTURE_SAMPLE_RATE

/**
 * Speaks every sentence once, then repeats the round until the clip is at least MIN_SECONDS long.
 * `run(command, args)` executes a system tool; injected so tests need no macOS.
 * @param {{ sentences?: string[], run?: (command: string, args: string[]) => void }} [options]
 */
export function buildCaptureWav({ sentences = englishSentences(), run = defaultRun } = {}) {
  if (sentences.length === 0) throw new Error('no English sentences in the fixture manifest')
  const scratch = mkdtempSync(join(tmpdir(), 'metis-capture-wav-'))
  try {
    const silence = Buffer.alloc(PAUSE_SECONDS * CAPTURE_SAMPLE_RATE * 2)
    const spoken = sentences.map((text, index) => {
      const aiff = join(scratch, `s${index}.aiff`)
      const wav = join(scratch, `s${index}.wav`)
      run('/usr/bin/say', sayArgs(text, aiff))
      run('/usr/bin/afconvert', afconvertArgs(aiff, wav))
      return pcmOf(readFileSync(wav))
    })
    const round = Buffer.concat(spoken.flatMap((pcm) => [pcm, silence]))
    const parts = []
    let total = 0
    while (total < MIN_SECONDS * CAPTURE_SAMPLE_RATE * 2) {
      parts.push(round)
      total += round.length
    }
    const pcm = Buffer.concat(parts)
    if (secondsOf(pcm) > MAX_SECONDS) throw new Error(`capture WAV would be ${Math.round(secondsOf(pcm))} s, over ${MAX_SECONDS} s`)
    return { wav: wavFromPcm(pcm), durationSeconds: secondsOf(pcm) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Writes the clip into `profileDir` (the only place the QA capture hook accepts it from).
 * @param {string} profileDir
 * @param {Parameters<typeof buildCaptureWav>[0]} [options]
 */
export function writeCaptureWav(profileDir, options) {
  const { wav, durationSeconds } = buildCaptureWav(options)
  mkdirSync(profileDir, { recursive: true })
  const path = join(profileDir, CAPTURE_WAV_NAME)
  writeFileSync(path, wav, { mode: 0o600 })
  return { path, sha256: createHash('sha256').update(wav).digest('hex'), durationSeconds }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const profileDir = process.argv[2]
  if (!profileDir) {
    console.error('Usage: node scripts/qa/meeting/capture-wav.mjs <profile-dir>')
    process.exit(2)
  }
  if (process.platform !== 'darwin') {
    console.error('capture-wav.mjs needs macOS (/usr/bin/say, /usr/bin/afconvert)')
    process.exit(2)
  }
  const { sha256, durationSeconds } = writeCaptureWav(profileDir)
  console.log(`sha256=${sha256} duration=${durationSeconds.toFixed(1)}s`)
}
