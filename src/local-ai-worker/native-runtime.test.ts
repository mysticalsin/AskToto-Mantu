import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertAbsoluteGgufPath,
  buildLlamaOptions,
  createNativeRuntime
} from './native-runtime.mjs'

const VALID_GGUF_PATH = '/models/local/model.gguf'

describe('buildLlamaOptions', () => {
  it('returns exact offline Darwin options', () => {
    expect(buildLlamaOptions('darwin', 'warn')).toEqual({
      gpu: 'metal',
      build: 'never',
      skipDownload: true,
      usePrebuiltBinaries: true,
      progressLogs: false,
      logLevel: 'warn'
    })
  })

  it('returns exact offline Windows options with CUDA excluded', () => {
    expect(buildLlamaOptions('win32', 'warn')).toEqual({
      gpu: { type: 'auto', exclude: ['cuda'] },
      build: 'never',
      skipDownload: true,
      usePrebuiltBinaries: true,
      progressLogs: false,
      logLevel: 'warn'
    })
  })

  it('rejects unsupported platforms', () => {
    expect(() => buildLlamaOptions('linux', 'warn')).toThrow(/unsupported/i)
    expect(() => buildLlamaOptions('freebsd', 'warn')).toThrow(/unsupported/i)
  })
})

describe('assertAbsoluteGgufPath', () => {
  it('accepts an absolute GGUF path', () => {
    expect(() => assertAbsoluteGgufPath(VALID_GGUF_PATH)).not.toThrow()
  })

  it.each([
    'https://example.com/model.gguf',
    'hf:org/model',
    'relative/model.gguf',
    '/models/local/model.bin',
    '/models/../etc/model.gguf',
    '/models/local/mo\0del.gguf'
  ])('rejects non-local model locator %#', (path) => {
    expect(() => assertAbsoluteGgufPath(path)).toThrow()
  })
})

function createFakeStack() {
  const sessionDispose = vi.fn()
  const sequenceDispose = vi.fn()
  const contextDispose = vi.fn()
  const modelDispose = vi.fn()
  const llamaDispose = vi.fn()
  const session = { prompt: vi.fn(), dispose: sessionDispose }
  const sequence = { tokenMeter: { usedOutputTokens: 0 }, dispose: sequenceDispose }
  const context = { getSequence: vi.fn(() => sequence), dispose: contextDispose }
  const model = { createContext: vi.fn(async () => context), dispose: modelDispose }
  const llama = { loadModel: vi.fn(async () => model), dispose: llamaDispose }
  const getLlama = vi.fn(async () => llama)
  const createChatSession = vi.fn(() => session)
  const resolveRuntimePaths = vi.fn(() => ({
    modulePath: '/app/Resources/app.asar/node_modules/node-llama-cpp/dist/index.js',
    bindingPath: '/app/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/native/llama-addon.node'
  }))

  return {
    context,
    createChatSession,
    disposals: { contextDispose, llamaDispose, modelDispose, sequenceDispose, sessionDispose },
    getLlama,
    llama,
    model,
    resolveRuntimePaths,
    sequence,
    session
  }
}

describe('createNativeRuntime', () => {
  let stack: ReturnType<typeof createFakeStack>

  beforeEach(() => {
    stack = createFakeStack()
  })

  function create(platform = 'darwin') {
    return createNativeRuntime({
      platform,
      warnLevel: 'warn',
      modelPath: VALID_GGUF_PATH,
      getLlama: stack.getLlama,
      createChatSession: stack.createChatSession,
      resolveRuntimePaths: stack.resolveRuntimePaths
    })
  }

  it('rejects unsupported platforms before initializing llama', async () => {
    await expect(create('linux')).rejects.toThrow(/unsupported/i)
    expect(stack.getLlama).not.toHaveBeenCalled()
  })

  it('loads the exact absolute model and creates one bounded context', async () => {
    const runtime = await create()

    expect(stack.llama.loadModel).toHaveBeenCalledWith({ modelPath: VALID_GGUF_PATH })
    expect(stack.model.createContext).toHaveBeenCalledWith({
      contextSize: 4096,
      batchSize: 512,
      sequences: 1
    })
    expect(stack.context.getSequence).toHaveBeenCalledTimes(1)
    expect(stack.createChatSession).toHaveBeenCalledWith(stack.sequence)
    expect(runtime).toMatchObject({
      modulePath: '/app/Resources/app.asar/node_modules/node-llama-cpp/dist/index.js',
      bindingPath: '/app/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/native/llama-addon.node'
    })
    await runtime.dispose()
  })

  it('counts every generated token without exposing hidden thought-segment text', async () => {
    const onTextChunk = vi.fn()
    const onGeneratedTokens = vi.fn()
    const abort = new AbortController()
    stack.session.prompt.mockImplementation(
      async (
        _prompt: string,
        options: {
          onTextChunk: (text: string) => void
          onResponseChunk: (chunk: { tokens: number[]; text: string }) => void
        }
      ) => {
        stack.sequence.tokenMeter.usedOutputTokens += 5
        options.onTextChunk('tok-1')
        options.onTextChunk('tok-2')
        options.onResponseChunk({ tokens: [1, 2], text: 'private thought segment' })
        return 'tok-1tok-2'
      }
    )
    const runtime = await create('win32')

    const result = await runtime.generate({
      prompt: 'hello',
      maxTokens: 5,
      signal: abort.signal,
      onTextChunk,
      onGeneratedTokens
    })

    expect(stack.session.prompt).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        maxTokens: 5,
        signal: abort.signal,
        onTextChunk,
        onResponseChunk: expect.any(Function)
      })
    )
    expect(onTextChunk).toHaveBeenNthCalledWith(1, 'tok-1')
    expect(onTextChunk).toHaveBeenNthCalledWith(2, 'tok-2')
    expect(onGeneratedTokens).toHaveBeenCalledWith(2)
    expect(JSON.stringify(onGeneratedTokens.mock.calls)).not.toContain('private thought segment')
    expect(result.tokenCount).toBe(5)
    await runtime.dispose()
  })

  it('disposes every native layer exactly once after a generation error', async () => {
    stack.session.prompt.mockRejectedValue(new Error('generation failed'))
    const runtime = await create()

    await expect(
      runtime.generate({
        prompt: 'hello',
        maxTokens: 5,
        signal: new AbortController().signal,
        onTextChunk: vi.fn()
      })
    ).rejects.toThrow('generation failed')
    await runtime.dispose()
    await runtime.dispose()

    for (const dispose of Object.values(stack.disposals)) expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes every native layer when runtime proof-path resolution fails', async () => {
    await expect(
      createNativeRuntime({
        platform: 'darwin',
        warnLevel: 'warn',
        modelPath: VALID_GGUF_PATH,
        getLlama: stack.getLlama,
        createChatSession: stack.createChatSession,
        resolveRuntimePaths: () => {
          throw new Error('proof path failed')
        }
      })
    ).rejects.toThrow('proof path failed')

    for (const dispose of Object.values(stack.disposals)) expect(dispose).toHaveBeenCalledTimes(1)
  })
})
