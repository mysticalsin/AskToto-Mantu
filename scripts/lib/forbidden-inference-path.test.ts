import { describe, expect, it } from 'vitest'
import { isForbiddenInferencePath } from './forbidden-inference-path.mjs'

describe('lean package inference payload path gate', () => {
  it.each([
    'node_modules/sherpa-onnx-win-x64/sherpa-onnx.node',
    'app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
    'out/renderer/assets/ort-wasm-simd-threaded.wasm',
    'out/renderer/assets/whisper.worker-Cb71.js',
    'out/main/whisper-asr-host.jsc',
    'resources/models/Xenova/whisper-base/onnx/model.onnx',
    'resources/local-llm/models/model.gguf'
  ])('rejects %s', (path) => {
    expect(isForbiddenInferencePath(path)).toBe(true)
  })

  it.each([
    'node_modules/@dust-tt/client/package.json',
    'out/renderer/assets/voice-meter-3r9.js',
    'resources/ffmpeg/darwin-arm64/ffmpeg',
    'resources/skills/caveman/SKILL.md'
  ])('retains core package content %s', (path) => {
    expect(isForbiddenInferencePath(path)).toBe(false)
  })
})
