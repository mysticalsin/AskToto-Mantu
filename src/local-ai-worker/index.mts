import { fileURLToPath } from 'node:url'
import { createNativeRuntime } from './native-runtime.mjs'
import { installNetworkDeny, type NetworkDenyGuard } from './network-deny.mjs'

const MAX_IPC_BYTES = 4 * 1024 * 1024

interface WorkerChannel {
  readonly pid: number
  readonly connected: boolean
  send(message: unknown): boolean
  exit(code: number): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'disconnect', listener: () => void): this
}

interface RuntimeLike {
  backend: 'metal' | 'vulkan' | 'cpu'
  modulePath: string
  bindingPath: string
  generate(options: {
    prompt: string
    maxTokens: number
    signal: AbortSignal
    onTextChunk: (text: string) => void
    onGeneratedTokens: (count: number) => void
  }): Promise<{ text: string; tokenCount: number }>
  dispose(): Promise<void>
}

interface RunWorkerOptions {
  channel: WorkerChannel
  platform: string
  workerPath: string
  installNetworkDeny: () => NetworkDenyGuard
  createNativeRuntime: (options: {
    modelPath: string
    platform: string
  }) => Promise<RuntimeLike>
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function bounded(value: unknown): boolean {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && Buffer.byteLength(json, 'utf8') <= MAX_IPC_BYTES
  } catch {
    return false
  }
}

function isHello(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'hello'
  nonce: string
  parentPid: number
} {
  return (
    exactKeys(value, ['nonce', 'parentPid', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'hello' &&
    typeof value.nonce === 'string' &&
    /^[0-9a-f]{64}$/.test(value.nonce) &&
    Number.isSafeInteger(value.parentPid) &&
    Number(value.parentPid) > 0
  )
}

function isGenerate(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'generate'
  id: string
  modelPath: string
  prompt: string
  maxTokens: number
} {
  return (
    exactKeys(value, ['id', 'maxTokens', 'modelPath', 'prompt', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'generate' &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.id) &&
    typeof value.modelPath === 'string' &&
    typeof value.prompt === 'string' &&
    Number.isSafeInteger(value.maxTokens) &&
    Number(value.maxTokens) >= 1 &&
    Number(value.maxTokens) <= 4096
  )
}

function isCancel(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'cancel'
  id: string
} {
  return (
    exactKeys(value, ['id', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'cancel' &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
  )
}

function isDispose(value: Record<string, unknown>): boolean {
  return exactKeys(value, ['type', 'version']) && value.version === 1 && value.type === 'dispose'
}

export function runWorkerProcess(options: RunWorkerOptions): void {
  const guard = options.installNetworkDeny()
  let phase: 'handshake' | 'ready' | 'closing' = 'handshake'
  let runtime: RuntimeLike | null = null
  let modelPath: string | null = null
  let active: { id: string; abort: AbortController } | null = null
  let activeTask: Promise<void> | null = null

  const send = (message: unknown): boolean =>
    phase !== 'closing' && options.channel.connected && bounded(message)
      ? options.channel.send(message)
      : false

  const shutdown = async (code: number, acknowledge: boolean): Promise<void> => {
    if (phase === 'closing') return
    phase = 'closing'
    const task = activeTask
    let safeToDispose = true
    active?.abort.abort()
    if (task) {
      let timer: NodeJS.Timeout | undefined
      const settled = await Promise.race([
        task.then(
          () => true,
          () => true
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000)
        })
      ])
      if (timer) clearTimeout(timer)
      if (!settled) {
        code = 1
        safeToDispose = false
      }
    }
    active = null
    activeTask = null
    if (safeToDispose) {
      try {
        await runtime?.dispose()
      } catch {
        code = 1
      }
    }
    runtime = null
    if (acknowledge && options.channel.connected) {
      options.channel.send({ version: 1, type: 'disposed' })
    }
    guard.restore()
    options.channel.exit(code)
  }

  const protocolFailure = (): void => {
    void shutdown(1, false)
  }

  const generate = async (message: ReturnType<typeof asGenerate>): Promise<void> => {
    if (!message || active) {
      if (message) send({ version: 1, type: 'error', id: message.id, code: 'WORKER_BUSY' })
      return
    }
    if (modelPath !== null && modelPath !== message.modelPath) {
      send({ version: 1, type: 'error', id: message.id, code: 'MODEL_PATH_CHANGED' })
      return
    }

    const abort = new AbortController()
    active = { id: message.id, abort }
    let generatedTokens = 0
    try {
      if (!runtime) {
        runtime = await options.createNativeRuntime({
          modelPath: message.modelPath,
          platform: options.platform
        })
        modelPath = message.modelPath
      }
      if (active?.id !== message.id || abort.signal.aborted) return
      const result = await runtime.generate({
        prompt: message.prompt,
        maxTokens: message.maxTokens,
        signal: abort.signal,
        onTextChunk: (text) => {
          if (active?.id === message.id && !abort.signal.aborted) {
            send({ version: 1, type: 'token', id: message.id, text })
          }
        },
        onGeneratedTokens: (count) => {
          if (active?.id === message.id && !abort.signal.aborted) {
            if (!Number.isSafeInteger(count) || count < 1 || generatedTokens + count > message.maxTokens) {
              throw new Error('Local AI worker received invalid generation progress.')
            }
            generatedTokens += count
            send({ version: 1, type: 'progress', id: message.id, generatedTokens })
          }
        }
      })
      if (active?.id !== message.id || abort.signal.aborted) return
      send({
        version: 1,
        type: 'done',
        id: message.id,
        tokenCount: result.tokenCount,
        backend: runtime.backend,
        workerPath: options.workerPath,
        modulePath: runtime.modulePath,
        bindingPath: runtime.bindingPath,
        networkAttempts: guard.attempts()
      })
    } catch {
      if (active?.id === message.id && !abort.signal.aborted) {
        send({ version: 1, type: 'error', id: message.id, code: 'GENERATION_FAILED' })
      }
    } finally {
      if (active?.id === message.id) {
        const cancelled = abort.signal.aborted
        active = null
        if (cancelled) send({ version: 1, type: 'cancelled', id: message.id })
      }
    }
  }

  function asGenerate(value: Record<string, unknown>) {
    return isGenerate(value) ? value : null
  }

  options.channel.on('message', (message) => {
    if (phase === 'closing' || !plainRecord(message) || !bounded(message)) {
      protocolFailure()
      return
    }
    if (phase === 'handshake') {
      if (!isHello(message)) {
        protocolFailure()
        return
      }
      phase = 'ready'
      send({ version: 1, type: 'ready', nonce: message.nonce, pid: options.channel.pid })
      return
    }
    if (isGenerate(message)) {
      const task = generate(message)
      activeTask = task
      void task.then(() => {
        if (activeTask === task) activeTask = null
      })
      return
    }
    if (isCancel(message)) {
      if (active?.id === message.id) active.abort.abort()
      return
    }
    if (isDispose(message)) {
      void shutdown(0, true)
      return
    }
    protocolFailure()
  })
  options.channel.on('disconnect', () => {
    void shutdown(0, false)
  })
}

if (typeof process.send === 'function' && process.env.ELECTRON_RUN_AS_NODE === '1') {
  const channel: WorkerChannel = {
    pid: process.pid,
    get connected() {
      return process.connected
    },
    send(message) {
      return process.send?.(message) ?? false
    },
    exit(code) {
      process.exit(code)
    },
    on(event, listener) {
      process.on(event, listener)
      return this
    }
  }
  runWorkerProcess({
    channel,
    platform: process.platform,
    workerPath: fileURLToPath(import.meta.url),
    installNetworkDeny,
    createNativeRuntime
  })
}
