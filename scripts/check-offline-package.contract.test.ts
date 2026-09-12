import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'check-offline-package.mjs'), 'utf8')

describe('check-offline-package Parakeet allowlist', () => {
  it('still forbids the sherpa-onnx asr-models URL outside the reviewed downloader', () => {
    expect(src).toMatch(/sherpa-onnx\\\/releases\\\/download\\\/asr-models/)
    expect(src).toMatch(/PARAKEET_DOWNLOAD_ALLOWED/)
    expect(src).toMatch(/src\/main\/asr-bundled-ensure\.ts/)
    expect(src).not.toMatch(/PARAKEET_DOWNLOAD_ALLOWED = \[[^\]]*src\/main\/index\.ts/)
  })

  it('does not disable the offline-package gate', () => {
    expect(src).toMatch(/process\.exit\(1\)/)
    expect(src).toMatch(/\[check:offline-package\] FAIL/)
  })

  it('does not claim optional model downloads are absent when it intentionally permits them', () => {
    expect(src).toContain("const QWEN_DOWNLOAD_ALLOWED = ['src/main/llm/local-models.ts', 'src/main/llm/local-model-download.ts']")
    expect(src).toContain('reviewed optional download paths only')
    expect(src).not.toContain('OK — no packaged model downloader')
  })
})
