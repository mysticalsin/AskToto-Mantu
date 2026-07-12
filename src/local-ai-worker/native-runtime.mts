import { getLlama, LlamaChatSession, LlamaLogLevel, type LlamaOptions } from 'node-llama-cpp'
import { realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type Llama = Awaited<ReturnType<typeof getLlama>>
type LlamaModel = Awaited<ReturnType<Llama['loadModel']>>
type LlamaContext = Awaited<ReturnType<LlamaModel['createContext']>>
type LlamaContextSequence = ReturnType<LlamaContext['getSequence']>
type Backend = 'metal' | 'vulkan' | 'cpu'

interface ChatSessionLike {
  prompt(
    prompt: string,
    options: {
      maxTokens: number
      signal: AbortSignal
      onTextChunk: (chunk: string) => void
      onResponseChunk?: (chunk: { tokens: readonly number[] }) => void
    }
  ): Promise<string>
  dispose(): void
}

interface CreateNativeRuntimeOptions {
  modelPath: string
  platform: string
  warnLevel?: LlamaLogLevel
  getLlama?: (options: LlamaOptions) => Promise<Llama>
  createChatSession?: (sequence: LlamaContextSequence) => ChatSessionLike
  resolveRuntimePaths?: (backend: Backend) => { modulePath: string; bindingPath: string }
}

interface GenerateOptions {
  prompt: string
  maxTokens: number
  signal: AbortSignal
  onTextChunk: (chunk: string) => void
  onGeneratedTokens?: (count: number) => void
}

const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
  'com¹',
  'com²',
  'com³',
  'lpt¹',
  'lpt²',
  'lpt³'
])

export function buildLlamaOptions(
  platform: string,
  warnLevel: LlamaLogLevel = LlamaLogLevel.warn
): LlamaOptions {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error('Unsupported local AI platform.')
  }
  return {
    gpu: platform === 'darwin' ? 'metal' : { type: 'auto', exclude: ['cuda'] },
    build: 'never',
    skipDownload: true,
    usePrebuiltBinaries: true,
    progressLogs: false,
    logLevel: warnLevel
  }
}

export function assertAbsoluteGgufPath(modelPath: string): void {
  if (
    typeof modelPath !== 'string' ||
    modelPath.length === 0 ||
    modelPath.includes('\u0000') ||
    modelPath.includes('?') ||
    modelPath.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(modelPath) && !/^[A-Za-z]:[\\/]/.test(modelPath)
  ) {
    throw new Error('Model path must be an absolute local GGUF file.')
  }

  const absolute =
    modelPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(modelPath) ||
    modelPath.startsWith('\\\\')
  const segments = modelPath.split(/[\\/]+/).filter(Boolean)
  if (
    !absolute ||
    !modelPath.toLowerCase().endsWith('.gguf') ||
    segments.some((segment) => segment === '.' || segment === '..') ||
    segments.some((segment) => WINDOWS_RESERVED.has(segment.split('.')[0].toLowerCase()))
  ) {
    throw new Error('Model path must be an absolute local GGUF file.')
  }
}

function defaultRuntimePaths(platform: string, backend: Backend): {
  modulePath: string
  bindingPath: string
} {
  const modulePath = fileURLToPath(import.meta.resolve('node-llama-cpp'))
  const nativePackage =
    platform === 'darwin'
      ? '@node-llama-cpp/mac-arm64-metal'
      : backend === 'vulkan'
        ? '@node-llama-cpp/win-x64-vulkan'
        : '@node-llama-cpp/win-x64'
  const targetDirectory = nativePackage.slice('@node-llama-cpp/'.length)
  const nativeEntry = fileURLToPath(import.meta.resolve(nativePackage))
  const logicalBinding = join(
    dirname(dirname(nativeEntry)),
    'bins',
    targetDirectory,
    'llama-addon.node'
  )
  const bindingPath = realpathSync(
    logicalBinding.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  )
  return { modulePath, bindingPath }
}

export async function createNativeRuntime(options: CreateNativeRuntimeOptions) {
  const llamaOptions = buildLlamaOptions(
    options.platform,
    options.warnLevel ?? LlamaLogLevel.warn
  )
  assertAbsoluteGgufPath(options.modelPath)
  const getLlamaImpl = options.getLlama ?? getLlama
  const createChatSession =
    options.createChatSession ??
    ((sequence: LlamaContextSequence): ChatSessionLike =>
      new LlamaChatSession({ contextSequence: sequence }))

  let llama: Llama | undefined
  let model: LlamaModel | undefined
  let context: LlamaContext | undefined
  let sequence: LlamaContextSequence | undefined
  let session: ChatSessionLike | undefined
  let disposed = false
  let activeSession!: ChatSessionLike
  let activeSequence!: LlamaContextSequence
  let backend!: Backend
  let runtimePaths!: { modulePath: string; bindingPath: string }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    let firstError: unknown
    const disposeOne = async (callback: (() => unknown) | undefined): Promise<void> => {
      if (!callback) return
      try {
        await callback()
      } catch (error) {
        firstError ??= error
      }
    }
    await disposeOne(session ? () => session?.dispose() : undefined)
    await disposeOne(sequence ? () => sequence?.dispose() : undefined)
    await disposeOne(context ? () => context?.dispose() : undefined)
    await disposeOne(model ? () => model?.dispose() : undefined)
    await disposeOne(llama ? () => llama?.dispose() : undefined)
    if (firstError) throw firstError
  }

  try {
    llama = await getLlamaImpl(llamaOptions)
    model = await llama.loadModel({ modelPath: options.modelPath })
    context = await model.createContext({ contextSize: 4096, batchSize: 512, sequences: 1 })
    sequence = context.getSequence()
    session = createChatSession(sequence)
    if (!session || !llama || !sequence) {
      throw new Error('Local AI native runtime did not initialize.')
    }
    activeSession = session
    activeSequence = sequence
    backend = llama.gpu === 'metal' ? 'metal' : llama.gpu === 'vulkan' ? 'vulkan' : 'cpu'
    runtimePaths = (
      options.resolveRuntimePaths ?? ((value) => defaultRuntimePaths(options.platform, value))
    )(backend)
  } catch (error) {
    try {
      await dispose()
    } catch {
      // Preserve the initialization/proof error while still attempting every cleanup layer.
    }
    throw error
  }

  return {
    backend,
    ...runtimePaths,
    async generate({ prompt, maxTokens, signal, onTextChunk, onGeneratedTokens }: GenerateOptions) {
      if (disposed) throw new Error('Local AI native runtime is disposed.')
      if (
        typeof prompt !== 'string' ||
        !Number.isSafeInteger(maxTokens) ||
        maxTokens < 1 ||
        maxTokens > 4096 ||
        !(signal instanceof AbortSignal) ||
        typeof onTextChunk !== 'function' ||
        (onGeneratedTokens !== undefined && typeof onGeneratedTokens !== 'function')
      ) {
        throw new Error('Local AI generation options are invalid.')
      }
      const initialOutputTokens = activeSequence.tokenMeter.usedOutputTokens
      const text = await activeSession.prompt(prompt, {
        maxTokens,
        signal,
        onTextChunk,
        onResponseChunk: ({ tokens }) => {
          if (tokens.length > 0) onGeneratedTokens?.(tokens.length)
        }
      })
      const tokenCount = activeSequence.tokenMeter.usedOutputTokens - initialOutputTokens
      if (!Number.isSafeInteger(tokenCount) || tokenCount < 0 || tokenCount > maxTokens) {
        throw new Error('Local AI runtime returned an invalid output token count.')
      }
      return { text, tokenCount }
    },
    dispose
  }
}
