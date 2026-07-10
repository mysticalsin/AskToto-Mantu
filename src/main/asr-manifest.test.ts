import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { asrManifestComplete, ASR_REQUIRED_FILES } from './asr-manifest'

function makeBundle(): string {
  const base = mkdtempSync(join(tmpdir(), 'asr-manifest-'))
  for (const parts of ASR_REQUIRED_FILES) {
    const p = join(base, ...parts)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x')
  }
  return base
}

describe('asrManifestComplete', () => {
  it('accepts a complete bundle', () => {
    const base = makeBundle()
    try {
      expect(asrManifestComplete(base)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects when any single file is missing (the tokenizer.json failure mode)', () => {
    const base = makeBundle()
    try {
      rmSync(join(base, 'models', 'Xenova', 'whisper-base', 'tokenizer.json'))
      expect(asrManifestComplete(base)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects a zero-byte file (interrupted download)', () => {
    const base = makeBundle()
    try {
      writeFileSync(join(base, 'models', 'Xenova', 'whisper-base', 'onnx', 'encoder_model_quantized.onnx'), '')
      expect(asrManifestComplete(base)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('rejects an empty/nonexistent base dir', () => {
    expect(asrManifestComplete(join(tmpdir(), 'definitely-not-a-real-asr-bundle'))).toBe(false)
  })
})
