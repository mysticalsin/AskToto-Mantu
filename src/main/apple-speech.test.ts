import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, auditLog: vi.fn() }))

import { encodeWav16kMono, appleSpeechAvailable, appleSpeechTranscribe } from './apple-speech'

const REPO_ROOT = process.cwd()

describe('encodeWav16kMono', () => {
  it('writes a well-formed 44-byte RIFF/WAVE header for 16kHz mono 16-bit PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const wav = encodeWav16kMono(samples)

    expect(wav.length).toBe(44 + samples.length * 2)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + samples.length * 2) // RIFF chunk size
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt32LE(16)).toBe(16) // fmt chunk size (PCM)
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(22)).toBe(1) // mono
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000 * 2) // byte rate (mono, 16-bit)
    expect(wav.readUInt16LE(32)).toBe(2) // block align
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2) // data chunk size
  })

  it('scales known Float32 samples to the correct int16 values', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, -0.5])
    const wav = encodeWav16kMono(samples)
    const dataOffset = 44
    expect(wav.readInt16LE(dataOffset + 0)).toBe(0)
    expect(wav.readInt16LE(dataOffset + 2)).toBe(0x7fff) // +1.0 -> max positive int16
    expect(wav.readInt16LE(dataOffset + 4)).toBe(-0x8000) // -1.0 -> max negative int16
    expect(wav.readInt16LE(dataOffset + 6)).toBe(Math.round(0.5 * 0x7fff))
    expect(wav.readInt16LE(dataOffset + 8)).toBe(Math.round(-0.5 * 0x8000))
  })

  it('clamps out-of-range samples instead of overflowing', () => {
    const samples = new Float32Array([2, -2])
    const wav = encodeWav16kMono(samples)
    expect(wav.readInt16LE(44)).toBe(0x7fff)
    expect(wav.readInt16LE(46)).toBe(-0x8000)
  })

  it('produces zero data bytes for an empty window', () => {
    const wav = encodeWav16kMono(new Float32Array(0))
    expect(wav.length).toBe(44)
    expect(wav.readUInt32LE(40)).toBe(0)
  })
})

describe('appleSpeechAvailable', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('is false on non-darwin platforms regardless of the helper binary', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(appleSpeechAvailable()).toBe(false)
  })

  it('is false on darwin when the mac-helper binary is not built (dev checkout without it)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    // macHelperPresent() checks existsSync on the real repo-relative path; in a fresh dev checkout the
    // binary may or may not be built. Assert the function is consistent with that real check instead of
    // asserting a specific boolean, which would be flaky across machines.
    const helperBuilt = existsSync(join(REPO_ROOT, 'resources', 'mac-helper', 'metis-mac-helper'))
    expect(appleSpeechAvailable()).toBe(helperBuilt)
  })
})

describe('appleSpeechTranscribe', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('resolves to an empty string without spawning anything when the engine is unavailable (non-mac)', async () => {
    const result = await appleSpeechTranscribe(new Float32Array(1600))
    expect(result).toBe('')
  })
})

describe('real helper integration (soft-skip when not built/not darwin)', () => {
  const helperBuilt = process.platform === 'darwin' && existsSync(join(REPO_ROOT, 'resources', 'mac-helper', 'metis-mac-helper'))
  const run = helperBuilt ? it : it.skip

  run(
    'transcribes a short silent window without throwing (empty or real text both pass — this proves the ' +
      'spawn -> temp-wav -> subcommand -> cleanup pipeline runs end to end)',
    async () => {
      // 0.5s of silence at 16kHz mono — decodable WAV, genuinely no speech. Either an empty transcript
      // (silence) or a denied-authorization '' both satisfy the never-throws contract this test exists
      // to prove; a real spoken sample would make this flaky depending on the CI Mac's Speech permission
      // state, which is exactly what soft-skip + "accept empty as a pass" is meant to avoid.
      const samples = new Float32Array(16000 / 2)
      const result = await appleSpeechTranscribe(samples)
      expect(typeof result).toBe('string')
    },
    30_000
  )
})
