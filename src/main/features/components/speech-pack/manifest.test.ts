import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PARAKEET_TDT_V3_INT8,
  SELF_TEST_FIXTURE,
  SPEECH_PACK_COMPONENTS,
  WHISPER_BASE_Q8,
  componentBytes,
  isImmutableUrl,
  speechPackFileUrl
} from './manifest'

interface Pin {
  bytes: number
  sha256: string
}
const runtime = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'resources', 'runtime-assets-manifest.json'), 'utf8')) as {
  assets: Record<string, Pin>
}
const WHISPER_PREFIX = 'resources/models/Xenova/whisper-base/'
const PARAKEET_PREFIX = 'resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/'

describe('speech-pack manifest pins', () => {
  it('whisper-base-q8 is 11 files, 81,263,214 bytes, matching the runtime assets manifest exactly', () => {
    expect(WHISPER_BASE_Q8.files).toHaveLength(11)
    expect(componentBytes(WHISPER_BASE_Q8)).toBe(81_263_214)
    for (const file of WHISPER_BASE_Q8.files) {
      expect(runtime.assets[WHISPER_PREFIX + file.path], file.path).toEqual({ bytes: file.bytes, sha256: file.sha256 })
    }
  })

  it('parakeet is encoder, decoder, joiner and tokens, 670,478,772 bytes, matching the runtime assets manifest exactly', () => {
    expect(PARAKEET_TDT_V3_INT8.files.map((f) => f.path).sort()).toEqual(['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'])
    expect(componentBytes(PARAKEET_TDT_V3_INT8)).toBe(670_478_772)
    for (const file of PARAKEET_TDT_V3_INT8.files) {
      expect(runtime.assets[PARAKEET_PREFIX + file.path], file.path).toEqual({ bytes: file.bytes, sha256: file.sha256 })
    }
  })

  it('the self-test fixture is the pinned 184,608-byte en.wav', () => {
    expect(runtime.assets[`${PARAKEET_PREFIX}test_wavs/en.wav`]).toEqual({ bytes: SELF_TEST_FIXTURE.bytes, sha256: SELF_TEST_FIXTURE.sha256 })
    expect(SELF_TEST_FIXTURE.bytes).toBe(184_608)
  })

  it('every file has a length, a full digest and a unique path', () => {
    for (const component of SPEECH_PACK_COMPONENTS) {
      const seen = new Set<string>()
      for (const file of component.files) {
        expect(file.bytes).toBeGreaterThan(0)
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(seen.has(file.path)).toBe(false)
        seen.add(file.path)
      }
    }
  })
})

describe('speech-pack sources are immutable', () => {
  it('rejects branch references and accepts commit-pinned URLs', () => {
    expect(isImmutableUrl('https://huggingface.co/Xenova/whisper-base/resolve/main/config.json')).toBe(false)
    expect(isImmutableUrl('https://huggingface.co/Xenova/whisper-base/resolve/master/config.json')).toBe(false)
    expect(isImmutableUrl('https://example.test/repo/refs/heads/dev/file')).toBe(false)
    expect(isImmutableUrl(`https://huggingface.co/Xenova/whisper-base/resolve/${'a'.repeat(40)}/config.json`)).toBe(true)
  })

  it('no declared source, and no URL built from one, names a branch', () => {
    for (const component of SPEECH_PACK_COMPONENTS) {
      for (const file of component.files) {
        const url = speechPackFileUrl(component, file)
        if (url !== null) {
          expect(isImmutableUrl(url)).toBe(true)
          expect(url).toMatch(/\/resolve\/[0-9a-f]{40}\//)
        }
      }
      if (component.source.kind === 'archive' && component.source.archive) {
        expect(isImmutableUrl(component.source.archive.url)).toBe(true)
        expect(component.source.archive.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(component.source.archive.bytes).toBeGreaterThan(componentBytes(component) / 4)
      }
    }
  })

  it('an unrecorded upstream pin yields no URL rather than a guessed one', () => {
    const unpinned = { ...WHISPER_BASE_Q8, source: { kind: 'files', baseUrl: null } } as const
    expect(speechPackFileUrl(unpinned, WHISPER_BASE_Q8.files[0])).toBeNull()
  })
})
