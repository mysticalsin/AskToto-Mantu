import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  acquireFeatureRuntime,
  configureRuntimeLeaseProvider,
  parseWindowsSystemRootsResponse,
  windowsSystemLoaderRoots,
  type VerifiedRuntimeGeneration
} from './runtime-lease'
import type { OptionalRuntimeTarget } from './runtime-components'

describe('Windows optional-host system loader roots', () => {
  it('accepts one syntactically valid absolute drive root and derives System32 beneath it', () => {
    expect(windowsSystemLoaderRoots('C:\\Windows')).toEqual(['C:\\Windows', 'C:\\Windows\\System32'])
  })

  it.each([
    ['relative', 'Windows'],
    ['UNC', '\\\\server\\share\\Windows'],
    ['delimiter injection', 'C:\\Windows;C:\\Injected'],
    ['parent traversal', 'C:\\Windows\\..\\Injected'],
    ['NUL', 'C:\\Windows\0;C:\\Injected']
  ])('rejects %s roots', (_label, value) => {
    expect(() => windowsSystemLoaderRoots(value)).toThrow(/system loader root is invalid/i)
  })

  it('accepts only the fixed helper response and API-derived System32 path', () => {
    expect(
      parseWindowsSystemRootsResponse({
        status: 0,
        stdout: '{"version":1,"windowsRoot":"C:\\\\Windows","systemRoot":"C:\\\\Windows\\\\System32"}\n',
        stderr: ''
      })
    ).toEqual({ windowsRoot: 'C:\\Windows', systemRoot: 'C:\\Windows\\System32' })
  })

  it('parses a syntactically valid response without asserting helper provenance', () => {
    expect(
      parseWindowsSystemRootsResponse({
        status: 0,
        stdout: '{"version":1,"windowsRoot":"Z:\\\\attacker","systemRoot":"Z:\\\\attacker\\\\System32"}\n',
        stderr: ''
      })
    ).toEqual({ windowsRoot: 'Z:\\attacker', systemRoot: 'Z:\\attacker\\System32' })
  })

  it.each([
    [
      'extra fields',
      0,
      '{"version":1,"windowsRoot":"C:\\\\Windows","systemRoot":"C:\\\\Windows\\\\System32","extra":true}\n',
      ''
    ],
    ['mismatched system directory', 0, '{"version":1,"windowsRoot":"C:\\\\Windows","systemRoot":"C:\\\\Evil"}\n', ''],
    [
      'stderr output',
      0,
      '{"version":1,"windowsRoot":"C:\\\\Windows","systemRoot":"C:\\\\Windows\\\\System32"}\n',
      'unexpected'
    ],
    ['nonzero status', 2, '{"version":1,"error":"ARGUMENTS_INVALID"}\n', '']
  ])('rejects helper response with %s', (_label, status, stdout, stderr) => {
    expect(() => parseWindowsSystemRootsResponse({ status, stdout, stderr })).toThrow()
  })

  it('snapshots roles and every model member before issuing a feature lease', async () => {
    const target: OptionalRuntimeTarget = {
      packageProfileIdentity: 'a'.repeat(64),
      packagePlatform: 'win32',
      packageArch: 'x64',
      runningPlatform: process.platform,
      runningArch: process.arch,
      appVersion: '1.0.0',
      electronVersion: process.versions.electron,
      nodeAbi: process.versions.modules,
      napiVersion: process.versions.napi,
      chromiumVersion: process.versions.chrome
    }
    const entries: Record<string, string> = {
      'parakeet-host': 'hosts/parakeet.exe',
      'whisper-import-host': 'hosts/whisper.js',
      'whisper-renderer-worker': 'worker/index.js'
    }
    const parakeetMembers = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
    const whisperMembers = [
      'Xenova/whisper-base/config.json',
      'Xenova/whisper-base/generation_config.json',
      'Xenova/whisper-base/merges.txt',
      'Xenova/whisper-base/normalizer.json',
      'Xenova/whisper-base/onnx/decoder_model_merged_quantized.onnx',
      'Xenova/whisper-base/onnx/encoder_model_quantized.onnx',
      'Xenova/whisper-base/preprocessor_config.json',
      'Xenova/whisper-base/special_tokens_map.json',
      'Xenova/whisper-base/tokenizer.json',
      'Xenova/whisper-base/tokenizer_config.json',
      'Xenova/whisper-base/vocab.json'
    ]
    const models: Record<string, { root: string; members: string[] }> = {
      'asr.parakeet-tdt-0.6b-v3-int8': { root: 'models/parakeet', members: parakeetMembers },
      'asr.whisper-base-q8': { root: 'models/whisper', members: whisperMembers }
    }
    const rendererFiles: Record<string, string> = { 'worker/index.js': 'worker/index.js' }
    const rendererPins: Record<string, { bytes: number; sha256: string }> = {
      'worker/index.js': { bytes: 10, sha256: 'd'.repeat(64) }
    }
    for (const member of whisperMembers) {
      const path = `models/whisper/${member}`
      rendererFiles[path] = path
      rendererPins[path] = { bytes: 10, sha256: 'e'.repeat(64) }
    }
    const generation: VerifiedRuntimeGeneration = {
      generationIdentity: 'b'.repeat(64),
      catalogIdentity: 'c'.repeat(64),
      target,
      rootDir: resolve('/owned/runtime-generation'),
      entries,
      models,
      nativeLibraryDirs: ['native'],
      rendererFiles,
      rendererPins,
      release: async () => undefined
    }
    configureRuntimeLeaseProvider({ acquire: async () => generation })
    const lease = await acquireFeatureRuntime('offline-asr', target)

    entries['whisper-import-host'] = 'outside/attacker.js'
    models['asr.whisper-base-q8'].members[0] = 'outside/attacker.onnx'
    rendererFiles['worker/index.js'] = 'outside/attacker.js'

    expect(lease.entry('whisper-import-host')).toBe(resolve('/owned/runtime-generation/hosts/whisper.js'))
    expect(lease.modelFile('asr.whisper-base-q8', 'Xenova/whisper-base/config.json')).toBe(
      resolve('/owned/runtime-generation/models/whisper/Xenova/whisper-base/config.json')
    )
    expect(lease.rendererFile('worker/index.js')).toBe(resolve('/owned/runtime-generation/worker/index.js'))
    expect(lease.rendererModelRoot('asr.whisper-base-q8')).toBe('models/whisper')
    await lease.release()
  })
})
