import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'prove-local-ttft.mjs'), 'utf8')
const assetSource = readFileSync(join(__dirname, 'local-model-assets.mjs'), 'utf8')
const MODEL_REVISION = '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0'

describe('local TTFT proof matches the production sidecar secret boundary', () => {
  it('passes the ephemeral llama-server key through the environment, never argv', () => {
    expect(source).not.toContain("'--api-key'")
    expect(source).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*LLAMA_API_KEY:\s*apiKey\s*\}/)
  })
})

describe('local model supply-chain and runtime proof contract', () => {
  it('pins every Qwen build-time URL and TTFT fallback URL to the reviewed immutable revision', () => {
    for (const script of [assetSource, source]) {
      expect(script).not.toContain('/resolve/main/')
      const qwenUrls = script.match(/https:\/\/huggingface\.co\/unsloth\/Qwen3\.5-0\.8B-GGUF\/resolve\/[^'\s]+/g) ?? []
      expect(qwenUrls).toHaveLength(2)
      expect(qwenUrls.every((url) => url.includes(`/resolve/${MODEL_REVISION}/`))).toBe(true)
    }
  })

  it('keeps the production proof on 32768 tokens per slot with the 128 MiB cache ceiling', () => {
    expect(source).toMatch(/'-c',\s*'65536'/)
    expect(source).toMatch(/'--parallel',\s*'2'/)
    expect(source).toMatch(/'--cache-ram',\s*'128'/)
  })

  it('preserves the reviewed model hashes while changing only URL mutability', () => {
    for (const script of [assetSource, source]) {
      expect(script).toContain('3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5')
      expect(script).toContain('56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453')
    }
  })
})
