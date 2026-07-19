import { isAbsolute } from 'node:path'

export const MAX_WORKER_IPC_BYTES = 4 * 1024 * 1024
export const MAX_WORKER_OUTPUT_BYTES = 2 * 1024 * 1024

type Backend = 'metal' | 'vulkan' | 'cpu'

export interface WorkerGenerateRequest {
  id: string
  modelPath: string
  prompt: string
  maxTokens: number
}

export interface WorkerGenerateResult {
  tokenCount: number
  backend: Backend
  workerPath: string
  modulePath: string
  bindingPath: string
  networkAttempts: number
}

interface WorkerChild {
  readonly pid?: number
  readonly connected: boolean
  send(message: unknown, callback?: (error: Error | null) => void): boolean
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
  on(event: 'error', listener: (error: Error) => void): this
}

interface WorkerControllerOptions<TTimer> {
  workerEntry: string
  execPath: string
  parentPid: number
  env: NodeJS.ProcessEnv
  fork: (
    modulePath: string,
    args: string[],
    options: Record<string, unknown>
  ) => WorkerChild
  randomBytes: (size: number) => Uint8Array
  setTimeout: (callback: () => void, delayMs: number) => TTimer
  clearTimeout: (timer: TTimer) => void
  handshakeTimeoutMs: number
}

interface Generation {
  id: string
  cancelled: boolean
  maxTokens: number
  progressTokens: number
  outputBytes: number
  eventCount: number
  onToken?: (text: string) => void
  onProgress?: (count: number) => void
  resolve: (result: WorkerGenerateResult) => void
  reject: (error: Error) => void
}

interface ChildContext<TTimer> {
  child: WorkerChild
  nonce: string
  timer: TTimer
  ready: Promise<{ pid: number }>
  resolveReady: (value: { pid: number }) => void
  rejectReady: (error: Error) => void
  readySettled: boolean
  intentionalStop: boolean
}

const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'windir',
  'ComSpec',
  'COMSPEC',
  'PATHEXT'
] as const

const BACKENDS = new Set<Backend>(['metal', 'vulkan', 'cpu'])

function staticError(message: string): Error {
  return new Error(`Local AI worker ${message}.`)
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

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(json, 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function assertBoundedMessage(value: unknown): void {
  if (jsonBytes(value) > MAX_WORKER_IPC_BYTES) throw staticError('message exceeds its byte limit')
}

function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    METIS_LOCAL_AI_DENY_NETWORK: '1'
  }
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string') clean[key] = value
  }
  return clean
}

function isReadyMessage(
  value: Record<string, unknown>,
  nonce: string,
  pid: number
): boolean {
  return (
    exactKeys(value, ['nonce', 'pid', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'ready' &&
    value.nonce === nonce &&
    value.pid === pid
  )
}

function isTokenMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'token'
  id: string
  text: string
} {
  return (
    exactKeys(value, ['id', 'text', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'token' &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.id) &&
    typeof value.text === 'string' &&
    Buffer.byteLength(value.text, 'utf8') <= 64 * 1024
  )
}

function isProgressMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'progress'
  id: string
  generatedTokens: number
} {
  return (
    exactKeys(value, ['generatedTokens', 'id', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'progress' &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.id) &&
    Number.isSafeInteger(value.generatedTokens) &&
    Number(value.generatedTokens) >= 1 &&
    Number(value.generatedTokens) <= 4096
  )
}

function isCancelledMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'cancelled'
  id: string
} {
  return (
    exactKeys(value, ['id', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'cancelled' &&
    typeof value.id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.id)
  )
}

function isDoneMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'done'
  id: string
  tokenCount: number
  backend: Backend
  workerPath: string
  modulePath: string
  bindingPath: string
  networkAttempts: number
} {
  return (
    exactKeys(value, [
      'backend',
      'bindingPath',
      'id',
      'modulePath',
      'networkAttempts',
      'tokenCount',
      'type',
      'version',
      'workerPath'
    ]) &&
    value.version === 1 &&
    value.type === 'done' &&
    typeof value.id === 'string' &&
    Number.isSafeInteger(value.tokenCount) &&
    Number(value.tokenCount) >= 0 &&
    BACKENDS.has(value.backend as Backend) &&
    typeof value.workerPath === 'string' &&
    isAbsolute(value.workerPath) &&
    typeof value.modulePath === 'string' &&
    isAbsolute(value.modulePath) &&
    typeof value.bindingPath === 'string' &&
    isAbsolute(value.bindingPath) &&
    Number.isSafeInteger(value.networkAttempts) &&
    Number(value.networkAttempts) >= 0
  )
}

function isErrorMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  version: 1
  type: 'error'
  id: string
  code: string
} {
  return (
    exactKeys(value, ['code', 'id', 'type', 'version']) &&
    value.version === 1 &&
    value.type === 'error' &&
    typeof value.id === 'string' &&
    typeof value.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/.test(value.code)
  )
}

function assertGenerateRequest(value: WorkerGenerateRequest): void {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ['id', 'maxTokens', 'modelPath', 'prompt']) ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.id) ||
    typeof value.modelPath !== 'string' ||
    !isAbsolute(value.modelPath) ||
    value.modelPath.includes('\u0000') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value.modelPath) ||
    typeof value.prompt !== 'string' ||
    !Number.isSafeInteger(value.maxTokens) ||
    value.maxTokens < 1 ||
    value.maxTokens > 4096
  ) {
    throw staticError('generation request is invalid')
  }
}

export function createWorkerController<TTimer>(options: WorkerControllerOptions<TTimer>) {
  let state: 'idle' | 'starting' | 'ready' | 'unavailable' | 'disposing' | 'disposed' = 'idle'
  let current: ChildContext<TTimer> | null = null
  let generation: Generation | null = null
  let respawnUsed = false
  let forceKillPending = false
  let disposePromise: Promise<void> | null = null
  let resolveDispose: (() => void) | null = null
  let disposeTimer: { value: TTimer } | null = null
  let forcedRespawn:
    | {
        previousPid: number
        resolve: (value: { previousPid: number; pid: number }) => void
        reject: (error: Error) => void
      }
    | null = null

  function rejectGeneration(error: Error): void {
    const pending = generation
    generation = null
    pending?.reject(error)
  }

  function settleReadyFailure(context: ChildContext<TTimer>, error: Error): void {
    if (context.readySettled) return
    context.readySettled = true
    options.clearTimeout(context.timer)
    context.rejectReady(error)
  }

  function failProtocol(context: ChildContext<TTimer>): void {
    if (context !== current) return
    const duringHandshake = state === 'starting'
    context.intentionalStop = true
    current = null
    state = 'unavailable'
    const error = staticError(duringHandshake ? 'handshake failed' : 'protocol failed')
    settleReadyFailure(context, error)
    rejectGeneration(error)
    forcedRespawn?.reject(error)
    forcedRespawn = null
    try {
      context.child.kill('SIGKILL')
    } catch {
      // The process is already gone.
    }
  }

  function finishDispose(context: ChildContext<TTimer>, kill: boolean): void {
    if (disposeTimer) {
      options.clearTimeout(disposeTimer.value)
      disposeTimer = null
    }
    if (current === context) current = null
    state = 'disposed'
    if (kill) {
      try {
        context.child.kill('SIGTERM')
      } catch {
        // The process is already gone.
      }
    }
    resolveDispose?.()
    resolveDispose = null
  }

  function handleMessage(context: ChildContext<TTimer>, message: unknown): void {
    if (context !== current || state === 'disposed') return
    if (!plainRecord(message) || jsonBytes(message) > MAX_WORKER_IPC_BYTES) {
      if (state === 'disposing') finishDispose(context, true)
      else failProtocol(context)
      return
    }
    if (state === 'disposing') {
      if (
        exactKeys(message, ['type', 'version']) &&
        message.version === 1 &&
        message.type === 'disposed'
      ) {
        finishDispose(context, true)
      } else {
        finishDispose(context, true)
      }
      return
    }
    if (state === 'starting') {
      const pid = context.child.pid
      if (pid === undefined || !isReadyMessage(message, context.nonce, pid)) {
        failProtocol(context)
        return
      }
      if (!context.readySettled) {
        context.readySettled = true
        options.clearTimeout(context.timer)
        state = 'ready'
        context.resolveReady({ pid })
      }
      return
    }

    if (state !== 'ready' || forceKillPending) return
    if (isTokenMessage(message)) {
      if (generation?.id !== message.id) {
        failProtocol(context)
        return
      }
      if (generation.cancelled) return
      generation.eventCount += 1
      generation.outputBytes += Buffer.byteLength(message.text, 'utf8')
      if (
        generation.eventCount > generation.maxTokens * 2 + 16 ||
        generation.outputBytes > MAX_WORKER_OUTPUT_BYTES
      ) {
        failProtocol(context)
        return
      }
      generation.onToken?.(message.text)
      return
    }
    if (isProgressMessage(message)) {
      if (generation?.id !== message.id) {
        failProtocol(context)
        return
      }
      if (generation.cancelled) return
      generation.eventCount += 1
      if (
        generation.eventCount > generation.maxTokens * 2 + 16 ||
        message.generatedTokens <= generation.progressTokens ||
        message.generatedTokens > generation.maxTokens
      ) {
        failProtocol(context)
        return
      }
      generation.progressTokens = message.generatedTokens
      generation.onProgress?.(message.generatedTokens)
      return
    }
    if (isCancelledMessage(message)) {
      if (generation?.id !== message.id || !generation.cancelled) {
        failProtocol(context)
        return
      }
      const pending = generation
      generation = null
      pending.reject(staticError('generation cancelled'))
      return
    }
    if (isDoneMessage(message)) {
      if (generation?.id !== message.id) {
        failProtocol(context)
        return
      }
      if (
        message.tokenCount > generation.maxTokens ||
        message.tokenCount < generation.progressTokens
      ) {
        failProtocol(context)
        return
      }
      const pending = generation
      generation = null
      if (pending.cancelled) {
        pending.reject(staticError('generation cancelled'))
        return
      }
      pending.resolve({
        tokenCount: message.tokenCount,
        backend: message.backend,
        workerPath: message.workerPath,
        modulePath: message.modulePath,
        bindingPath: message.bindingPath,
        networkAttempts: message.networkAttempts
      })
      return
    }
    if (isErrorMessage(message)) {
      if (generation?.id !== message.id) {
        failProtocol(context)
        return
      }
      if (generation.cancelled) {
        const pending = generation
        generation = null
        pending.reject(staticError('generation cancelled'))
        return
      }
      rejectGeneration(staticError(`reported ${message.code}`))
      return
    }
    failProtocol(context)
  }

  function spawnWorker(): Promise<{ pid: number }> {
    if (state === 'disposing' || state === 'disposed') {
      return Promise.reject(staticError('is disposed'))
    }
    state = 'starting'
    const nonce = Buffer.from(options.randomBytes(32)).toString('hex')
    if (!/^[0-9a-f]{64}$/.test(nonce)) {
      state = 'unavailable'
      return Promise.reject(staticError('nonce generation failed'))
    }

    let resolveReady!: (value: { pid: number }) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<{ pid: number }>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    let child: WorkerChild
    try {
      child = options.fork(options.workerEntry, [], {
        execPath: options.execPath,
        execArgv: [],
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        env: childEnvironment(options.env)
      })
    } catch {
      state = 'unavailable'
      rejectReady(staticError('could not start'))
      return ready
    }

    const context = {
      child,
      nonce,
      timer: undefined as TTimer,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      intentionalStop: false
    }
    current = context
    context.timer = options.setTimeout(() => {
      if (context !== current || context.readySettled) return
      context.intentionalStop = true
      current = null
      state = 'unavailable'
      settleReadyFailure(context, staticError('handshake timeout'))
      try {
        context.child.kill('SIGKILL')
      } catch {
        // The process is already gone.
      }
    }, options.handshakeTimeoutMs)

    child.on('message', (message) => handleMessage(context, message))
    child.on('error', () => handleExit(context))
    child.on('exit', () => handleExit(context))

    const hello = { version: 1, type: 'hello', nonce, parentPid: options.parentPid } as const
    try {
      assertBoundedMessage(hello)
      child.send(hello, (error) => {
        if (error) failProtocol(context)
      })
    } catch {
      failProtocol(context)
    }
    return ready
  }

  function handleExit(context: ChildContext<TTimer>): void {
    if (context !== current) return
    if (state === 'disposing') {
      finishDispose(context, false)
      return
    }
    current = null
    forceKillPending = false
    if (!context.readySettled) settleReadyFailure(context, staticError('exited during handshake'))
    rejectGeneration(staticError('generation terminated'))

    if (state === 'disposed' || context.intentionalStop) return
    if (respawnUsed) {
      state = 'unavailable'
      const error = staticError('is unavailable')
      forcedRespawn?.reject(error)
      forcedRespawn = null
      return
    }

    respawnUsed = true
    const waiter = forcedRespawn
    spawnWorker().then(
      ({ pid }) => {
        if (waiter) waiter.resolve({ previousPid: waiter.previousPid, pid })
        if (forcedRespawn === waiter) forcedRespawn = null
      },
      (error: Error) => {
        state = 'unavailable'
        waiter?.reject(error)
        if (forcedRespawn === waiter) forcedRespawn = null
      }
    )
  }

  function start(): Promise<{ pid: number }> {
    if (state === 'disposing' || state === 'disposed') {
      return Promise.reject(staticError('is disposed'))
    }
    if (state === 'unavailable') return Promise.reject(staticError('is unavailable'))
    if (current && (state === 'starting' || state === 'ready')) return current.ready
    return spawnWorker()
  }

  function generate(
    request: WorkerGenerateRequest,
    onToken?: (text: string) => void,
    onProgress?: (count: number) => void
  ): Promise<WorkerGenerateResult> {
    try {
      assertGenerateRequest(request)
    } catch (error) {
      return Promise.reject(error)
    }
    if (state === 'disposing' || state === 'disposed') {
      return Promise.reject(staticError('is disposed'))
    }
    if (state === 'unavailable') return Promise.reject(staticError('is unavailable'))
    if (state !== 'ready' || !current) return Promise.reject(staticError('is not ready'))
    if (generation) return Promise.reject(staticError('already has an active generation'))

    const message = {
      version: 1,
      type: 'generate',
      id: request.id,
      modelPath: request.modelPath,
      prompt: request.prompt,
      maxTokens: request.maxTokens
    } as const
    try {
      assertBoundedMessage(message)
    } catch (error) {
      return Promise.reject(error)
    }

    return new Promise<WorkerGenerateResult>((resolve, reject) => {
      generation = {
        id: request.id,
        cancelled: false,
        maxTokens: request.maxTokens,
        progressTokens: 0,
        outputBytes: 0,
        eventCount: 0,
        onToken,
        onProgress,
        resolve,
        reject
      }
      try {
        current?.child.send(message, (error) => {
          if (error && generation?.id === request.id) {
            rejectGeneration(staticError('send failed'))
          }
        })
      } catch {
        rejectGeneration(staticError('send failed'))
      }
    })
  }

  function cancel(id: string): void {
    const pending = generation
    if (!pending || pending.id !== id || !current || state !== 'ready') return
    if (pending.cancelled) return
    pending.cancelled = true
    const context = current
    try {
      context.child.send({ version: 1, type: 'cancel', id } as const, (error) => {
        if (error) failProtocol(context)
      })
    } catch {
      failProtocol(context)
    }
  }

  function forceKillForSelfTest(): Promise<{ previousPid: number; pid: number }> {
    if (!current || state !== 'ready' || current.child.pid === undefined) {
      return Promise.reject(staticError('is not ready'))
    }
    if (respawnUsed || forcedRespawn) return Promise.reject(staticError('respawn is unavailable'))
    if (!generation) return Promise.reject(staticError('has no active generation'))
    const child = current.child
    const previousPid = child.pid
    if (previousPid === undefined) return Promise.reject(staticError('is not ready'))
    const result = new Promise<{ previousPid: number; pid: number }>((resolve, reject) => {
      forcedRespawn = { previousPid, resolve, reject }
    })
    forceKillPending = true
    try {
      if (!child.kill('SIGKILL')) {
        forceKillPending = false
        forcedRespawn = null
        return Promise.reject(staticError('force kill failed'))
      }
    } catch {
      forceKillPending = false
      forcedRespawn = null
      return Promise.reject(staticError('force kill failed'))
    }
    return result
  }

  async function dispose(): Promise<void> {
    if (state === 'disposed') return
    if (disposePromise) return disposePromise
    state = 'disposing'
    forceKillPending = false
    const context = current
    rejectGeneration(staticError('is disposed'))
    forcedRespawn?.reject(staticError('is disposed'))
    forcedRespawn = null
    if (!context) {
      state = 'disposed'
      return
    }
    context.intentionalStop = true
    if (!context.readySettled) settleReadyFailure(context, staticError('is disposed'))
    disposePromise = new Promise<void>((resolve) => {
      resolveDispose = resolve
    })
    disposeTimer = {
      value: options.setTimeout(() => finishDispose(context, true), 2000)
    }
    try {
      if (context.child.connected) {
        context.child.send({ version: 1, type: 'dispose' } as const, (error) => {
          if (error) finishDispose(context, true)
        })
      } else {
        finishDispose(context, false)
      }
    } catch {
      finishDispose(context, true)
    }
    return disposePromise
  }

  return { start, generate, cancel, forceKillForSelfTest, dispose }
}
