import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  isLocalAiNativeSelftest,
  runPackagedLocalAiSelftest,
  writePackagedSelftestResult
} from './packaged-selftest'

const APP_RESOURCES = '/detached/Metis.app/Contents/Resources'
const LOCAL_AI_ROOT = `${APP_RESOURCES}/local-ai`
const WORKER_PATH = `${APP_RESOURCES}/app.asar/out/local-ai-worker/index.mjs`
const MODULE_PATH = `${APP_RESOURCES}/app.asar/node_modules/node-llama-cpp/dist/index.js`
const BINDING_PATH = `${APP_RESOURCES}/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node`
const MODEL = {
  id: 'qwen3-0.6b-q8-0',
  sha256: 'a'.repeat(64),
  absolutePath: `${LOCAL_AI_ROOT}/text/qwen3-0.6b-q8-0/model.gguf`
}
const OUTPUT = join(tmpdir(), 'metis-local-ai-native-result.json')
const RESULT_FIELDS = [
  'arch',
  'backend',
  'bindingPath',
  'error',
  'firstTokenCount',
  'modelId',
  'modelSha256',
  'modulePath',
  'networkAttempts',
  'packaged',
  'pid',
  'platform',
  'postRespawnTokenCount',
  'previousPid',
  'resourcesRoot',
  'respawnCount',
  'status',
  'timingsMs',
  'version',
  'windowCount',
  'workerPath'
].sort()

function buildHarness(overrides: Record<string, unknown> = {}) {
  const order: string[] = []
  let rejectInterrupted: ((error: Error) => void) | null = null
  const controller = {
    start: vi.fn(async () => {
      order.push('start')
      return { pid: 4100 }
    }),
    generate: vi.fn(
      (
        request: { id: string; maxTokens: number },
        _onToken?: (text: string) => void,
        onProgress?: (count: number) => void
      ) => {
        order.push(`generate:${request.maxTokens}`)
        if (request.maxTokens === 5) {
          return Promise.resolve({
            tokenCount: 5,
            backend: 'metal',
            workerPath: WORKER_PATH,
            modulePath: MODULE_PATH,
            bindingPath: BINDING_PATH,
            networkAttempts: 0
          })
        }
        queueMicrotask(() => onProgress?.(1))
        return new Promise((_resolve, reject) => {
          rejectInterrupted = reject
        })
      }
    ),
    forceKillForSelfTest: vi.fn(async () => {
      order.push('forceKill')
      rejectInterrupted?.(new Error('worker terminated'))
      rejectInterrupted = null
      return { previousPid: 4100, pid: 4101 }
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    })
  }
  const writeResult = vi.fn(async () => {
    order.push('writeResult')
  })
  const options = {
    env: { METIS_SELFTEST_KIND: 'local-ai-native', METIS_SELFTEST_OUTPUT: OUTPUT },
    isPackaged: true,
    platform: 'darwin',
    arch: 'arm64',
    appResourcesPath: APP_RESOURCES,
    resourcesRoot: LOCAL_AI_ROOT,
    workerPath: WORKER_PATH,
    bindingPath: BINDING_PATH,
    installNetworkDeny: vi.fn(() => {
      order.push('denyNetwork')
    }),
    getNetworkAttempts: vi.fn(() => 0),
    getWindowCount: vi.fn(() => 0),
    resolveModel: vi.fn(async () => {
      order.push('resolveModel')
      return MODEL
    }),
    createController: vi.fn(() => {
      order.push('createController')
      return controller
    }),
    writeResult,
    now: vi.fn(() => 1000),
    ...overrides
  }
  return { controller, options, order, writeResult }
}

describe('isLocalAiNativeSelftest', () => {
  it('matches only the exact local native kind', () => {
    expect(isLocalAiNativeSelftest({ METIS_SELFTEST_KIND: 'local-ai-native' })).toBe(true)
    expect(isLocalAiNativeSelftest({})).toBe(false)
    expect(isLocalAiNativeSelftest({ METIS_SELFTEST_KIND: 'LOCAL-AI-NATIVE' })).toBe(false)
    expect(isLocalAiNativeSelftest({ METIS_SELFTEST_KIND: 'local-ai-cloud' })).toBe(false)
  })
})

describe('runPackagedLocalAiSelftest', () => {
  it.each([undefined, 'relative/result.json'])('rejects invalid result path before side effects', async (output) => {
    const harness = buildHarness({
      env: {
        METIS_SELFTEST_KIND: 'local-ai-native',
        ...(output === undefined ? {} : { METIS_SELFTEST_OUTPUT: output })
      }
    })

    await expect(runPackagedLocalAiSelftest(harness.options)).rejects.toThrow(/absolute/i)
    expect(harness.options.installNetworkDeny).not.toHaveBeenCalled()
    expect(harness.options.resolveModel).not.toHaveBeenCalled()
    expect(harness.options.createController).not.toHaveBeenCalled()
    expect(harness.writeResult).not.toHaveBeenCalled()
  })

  it('installs the network deny before model or native initialization', async () => {
    const harness = buildHarness()
    await runPackagedLocalAiSelftest(harness.options)

    expect(harness.order.indexOf('denyNetwork')).toBeLessThan(harness.order.indexOf('resolveModel'))
    expect(harness.order.indexOf('denyNetwork')).toBeLessThan(harness.order.indexOf('createController'))
  })

  it('generates, kills after a token, respawns once, generates again, and disposes', async () => {
    const harness = buildHarness()
    await runPackagedLocalAiSelftest(harness.options)

    const first = harness.order.indexOf('generate:5')
    const interrupted = harness.order.indexOf('generate:128')
    const killed = harness.order.indexOf('forceKill')
    const second = harness.order.lastIndexOf('generate:5')
    expect(harness.order.indexOf('start')).toBeLessThan(first)
    expect(first).toBeLessThan(interrupted)
    expect(interrupted).toBeLessThan(killed)
    expect(killed).toBeLessThan(second)
    expect(second).toBeLessThan(harness.order.indexOf('dispose'))
    expect(harness.controller.forceKillForSelfTest).toHaveBeenCalledTimes(1)
    expect(harness.controller.dispose).toHaveBeenCalledTimes(1)
  })

  it('writes a strict result without model content or credentials', async () => {
    const harness = buildHarness()
    const result = await runPackagedLocalAiSelftest(harness.options)

    expect(Object.keys(result).sort()).toEqual(RESULT_FIELDS)
    expect(result).toMatchObject({
      version: 1,
      status: 'passed',
      packaged: true,
      platform: 'darwin',
      arch: 'arm64',
      modelId: MODEL.id,
      modelSha256: MODEL.sha256,
      backend: 'metal',
      resourcesRoot: LOCAL_AI_ROOT,
      workerPath: WORKER_PATH,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      firstTokenCount: 5,
      postRespawnTokenCount: 5,
      previousPid: 4100,
      pid: 4101,
      respawnCount: 1,
      networkAttempts: 0,
      windowCount: 0,
      error: null
    })
    expect(harness.writeResult).toHaveBeenCalledWith(OUTPUT, result)
    const serialized = JSON.stringify(result).toLowerCase()
    for (const forbidden of [
      'prompt',
      'generatedtext',
      'transcript',
      'screenshot',
      'ocr',
      'credential',
      'api_key',
      'secret'
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(16 * 1024)
  })

  it.each([
    ['not packaged', { isPackaged: false }],
    ['open window', { getWindowCount: vi.fn(() => 1) }],
    ['network attempt', { getNetworkAttempts: vi.fn(() => 1) }],
    ['escaped model', { resolveModel: vi.fn(async () => ({ ...MODEL, absolutePath: '/tmp/model.gguf' })) }]
  ])('fails closed for %s', async (_label, override) => {
    const harness = buildHarness(override)
    await expect(runPackagedLocalAiSelftest(harness.options)).rejects.toThrow()
    expect(harness.writeResult).toHaveBeenCalledTimes(1)
    expect(harness.writeResult.mock.calls[0][1]).toMatchObject({ status: 'failed' })
  })

  it('disposes, writes a sanitized failure, and rejects for a nonzero exit path', async () => {
    const secret = 'sk-live-do-not-leak'
    const harness = buildHarness()
    harness.controller.start.mockRejectedValueOnce(new Error(`native init failed ${secret}`))

    await expect(runPackagedLocalAiSelftest(harness.options)).rejects.toThrow(/self-test failed/i)
    expect(harness.controller.dispose).toHaveBeenCalledTimes(1)
    const result = harness.writeResult.mock.calls[0][1]
    expect(Object.keys(result).sort()).toEqual(RESULT_FIELDS)
    expect(result.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('main-process integration order', () => {
  it('dispatches the native self-test before proxy/provider and window initialization', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const dispatch = source.indexOf('if (isLocalAiNativeSelftest(process.env))')
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(dispatch).toBeLessThan(source.indexOf('installProxyAwareFetch()', dispatch))
    expect(dispatch).toBeLessThan(source.indexOf('prewarmCli()', dispatch))
    expect(dispatch).toBeLessThan(source.indexOf('createWindow()', dispatch))
  })
})

describe('writePackagedSelftestResult', () => {
  it('atomically writes one bounded private JSON file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'metis-selftest-result-'))
    try {
      const result = await runPackagedLocalAiSelftest(buildHarness().options)
      const output = join(directory, 'result.json')
      await writePackagedSelftestResult(output, result)

      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(result)
      expect(readdirSync(directory)).toEqual(['result.json'])
      if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a relative output path', async () => {
    const result = await runPackagedLocalAiSelftest(buildHarness().options)
    await expect(writePackagedSelftestResult('result.json', result)).rejects.toThrow(/absolute/i)
  })
})
