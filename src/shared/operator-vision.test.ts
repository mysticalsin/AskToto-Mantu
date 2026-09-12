import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { operatorVisionModel, OPERATOR_IMAGE_BASE64_CAP, OPERATOR_VISION_MODEL, parseOperatorImage } from './operator-vision'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG = readFileSync(new URL('../renderer/src/assets/mantu-mark.jpg', import.meta.url)).toString('base64')

describe('MQA-301 managed screenshot validation', () => {
  it.each([['image/png', PNG], ['image/jpeg', JPEG]])('accepts a real %s file without changing its bytes', (mimeType, data) => {
    expect(parseOperatorImage({ mimeType, data })).toEqual({ ok: true, image: { mimeType, data } })
  })

  it.each([
    ['unsupported MIME', { mimeType: 'image/webp', data: PNG }],
    ['JPEG labelled as PNG', { mimeType: 'image/png', data: JPEG }],
    ['PNG labelled as JPEG', { mimeType: 'image/jpeg', data: PNG }],
    ['extra remote source', { mimeType: 'image/png', data: PNG, url: 'https://example.test/image' }],
    ['incomplete PNG', { mimeType: 'image/png', data: Buffer.from(PNG, 'base64').subarray(0, -12).toString('base64') }],
    ['incomplete JPEG', { mimeType: 'image/jpeg', data: Buffer.from(JPEG, 'base64').subarray(0, -2).toString('base64') }],
    ['oversize data', { mimeType: 'image/png', data: 'A'.repeat(OPERATOR_IMAGE_BASE64_CAP + 4) }]
  ])('rejects %s without echoing the screenshot', (_name, input) => {
    const result = parseOperatorImage(input)
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(PNG)
    expect(JSON.stringify(result)).not.toContain(JPEG)
  })

  it.each([[0, 1], [1, 0], [8193, 1], [1, 8193], [8192, 8192]])('rejects unsafe dimensions %i by %i without decompressing pixels', (width, height) => {
    const image = Buffer.from(PNG, 'base64')
    image.writeUInt32BE(width, 16)
    image.writeUInt32BE(height, 20)
    expect(parseOperatorImage({ mimeType: 'image/png', data: image.toString('base64') }).ok).toBe(false)
  })
})

describe('managed vision model allowlist', () => {
  it('pins Cloudflare screenshots to Scout instead of a text-only tier', () => {
    expect(operatorVisionModel('cloudflare', '@cf/deepseek-ai/deepseek-v4-flash-0731')).toBe(OPERATOR_VISION_MODEL)
  })

  it.each([
    ['openai', 'gpt-4o-mini'], ['anthropic', 'claude-haiku-4-5-20251001'],
    ['kimi', 'kimi-for-coding'], ['gemini', 'gemini-2.5-flash'],
    ['openrouter', 'openai/gpt-4o-mini'], ['grok', 'grok-4']
  ])('accepts the supported %s model %s', (provider, model) => {
    expect(operatorVisionModel(provider, model)).toBe(model)
  })

  it.each([
    ['openai', 'unknown-text-model'], ['deepseek', 'deepseek-v4-flash'],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct'], ['grok', 'grok-3-mini'],
    ['cloudflare', 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct'],
    ['__proto__', 'model'], ['custom', 'model'], ['local', 'model']
  ])('rejects unsupported %s model %s', (provider, model) => {
    expect(operatorVisionModel(provider, model)).toBeNull()
  })
})
