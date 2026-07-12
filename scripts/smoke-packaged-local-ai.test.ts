import { describe, expect, it } from 'vitest'
import {
  parseSmokeArgs,
  validateSelftestResult
} from './smoke-packaged-local-ai.mjs'

const paths = {
  resources: '/tmp/detached/Métis.app/Contents/Resources',
  worker: '/tmp/detached/Métis.app/Contents/Resources/app.asar/out/local-ai-worker/index.mjs',
  module: '/tmp/detached/Métis.app/Contents/Resources/app.asar/node_modules/node-llama-cpp/dist/index.js',
  binding: '/tmp/detached/Métis.app/Contents/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node'
}

function result() {
  return {
    version: 1,
    status: 'passed',
    packaged: true,
    platform: 'darwin',
    arch: 'arm64',
    modelId: 'qwen3-0.6b-q8-0',
    modelSha256: 'a'.repeat(64),
    backend: 'metal',
    resourcesRoot: `${paths.resources}/local-ai`,
    workerPath: paths.worker,
    modulePath: paths.module,
    bindingPath: paths.binding,
    firstTokenCount: 5,
    postRespawnTokenCount: 5,
    previousPid: 100,
    pid: 101,
    respawnCount: 1,
    networkAttempts: 0,
    windowCount: 0,
    timingsMs: { total: 10 },
    error: null
  }
}

describe('parseSmokeArgs', () => {
  it('accepts exactly one absolute app and result path', () => {
    expect(parseSmokeArgs(['--app', '/tmp/Métis', '--result', '/tmp/result.json'])).toEqual({
      app: '/tmp/Métis',
      result: '/tmp/result.json'
    })
  })

  it.each([
    [],
    ['--app', 'relative', '--result', '/tmp/result.json'],
    ['--app', '/tmp/Métis', '--result', 'relative'],
    ['--app', '/tmp/a', '--app', '/tmp/b', '--result', '/tmp/result.json'],
    ['--app', '/tmp/a', '--result', '/tmp/result.json', '--unknown']
  ])('rejects malformed arguments %#', (args) => {
    expect(() => parseSmokeArgs(args)).toThrow()
  })
})

describe('validateSelftestResult', () => {
  it('accepts the strict detached Mac proof', () => {
    expect(
      validateSelftestResult(result(), {
        platform: 'darwin-arm64',
        resourcesPath: paths.resources,
        modelId: 'qwen3-0.6b-q8-0',
        modelSha256: 'a'.repeat(64)
      })
    ).toEqual(result())
  })

  it.each([
    ['extra field', { output: 'secret generated text' }],
    ['wrong backend', { backend: 'cpu' }],
    ['network use', { networkAttempts: 1 }],
    ['same pid', { pid: 100 }],
    ['escaped worker', { workerPath: '/tmp/outside/index.mjs' }],
    ['unpacked module', { modulePath: paths.module.replace('app.asar/', 'app.asar.unpacked/') }],
    ['packed binding', { bindingPath: paths.binding.replace('app.asar.unpacked/', 'app.asar/') }],
    ['wrong model', { modelSha256: 'b'.repeat(64) }]
  ])('rejects %s', (_label, mutation) => {
    expect(() =>
      validateSelftestResult(
        { ...result(), ...mutation },
        {
          platform: 'darwin-arm64',
          resourcesPath: paths.resources,
          modelId: 'qwen3-0.6b-q8-0',
          modelSha256: 'a'.repeat(64)
        }
      )
    ).toThrow()
  })
})
