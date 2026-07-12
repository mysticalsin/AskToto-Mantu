import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_WORKER_IPC_BYTES,
  MAX_WORKER_OUTPUT_BYTES,
  createWorkerController
} from './worker-controller'

const WORKER_ENTRY = '/detached/Metis.app/Contents/Resources/app.asar/out/local-ai-worker/index.mjs'
const EXEC_PATH = '/detached/Metis.app/Contents/MacOS/Metis'
const MODEL_PATH = '/detached/Metis.app/Contents/Resources/local-ai/text/model.gguf'
const MODULE_PATH = '/detached/Metis.app/Contents/Resources/app.asar/node_modules/node-llama-cpp/dist/index.js'
const BINDING_PATH = '/detached/Metis.app/Contents/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node'
const PARENT_PID = 4242
const NONCE_1 = 'a1'.repeat(32)
const NONCE_2 = 'b2'.repeat(32)

const BASE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  LANG: 'en_US.UTF-8',
  HTTP_PROXY: 'http://proxy.internal:8080',
  https_proxy: 'http://proxy.internal:8080',
  NO_PROXY: 'localhost',
  NODE_OPTIONS: '--inspect=9229',
  ELECTRON_NO_ASAR: '1',
  HF_TOKEN: 'hf_secret',
  HUGGINGFACE_HUB_TOKEN: 'hf_secret_2',
  OPENAI_API_KEY: 'openai_secret',
  ANTHROPIC_API_KEY: 'anthropic_secret',
  GOOGLE_API_KEY: 'google_secret',
  AWS_SECRET_ACCESS_KEY: 'aws_secret',
  GH_TOKEN: 'github_secret',
  CSC_KEY_PASSWORD: 'signing_secret'
}

class FakeChild extends EventEmitter {
  readonly sent: unknown[] = []
  connected = true
  killed = false
  signal: NodeJS.Signals | undefined

  constructor(readonly pid: number) {
    super()
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    this.connected = false
    this.signal = signal
    return true
  }
}

function createTimers() {
  let nextId = 0
  const pending = new Map<number, () => void>()
  return {
    setTimeout: vi.fn((callback: () => void) => {
      const id = ++nextId
      pending.set(id, callback)
      return id
    }),
    clearTimeout: vi.fn((id: number) => pending.delete(id)),
    fireAll(): void {
      for (const [id, callback] of [...pending]) {
        pending.delete(id)
        callback()
      }
    }
  }
}

function createHarness() {
  const children: FakeChild[] = []
  const forkCalls: Array<{ modulePath: string; args: string[]; options: Record<string, unknown> }> = []
  const pids = [1001, 1002, 1003]
  const nonces = [NONCE_1, NONCE_2, 'c3'.repeat(32)]
  const timers = createTimers()
  const fork = vi.fn((modulePath: string, args: string[], options: Record<string, unknown>) => {
    forkCalls.push({ modulePath, args, options })
    const child = new FakeChild(pids[children.length])
    children.push(child)
    return child
  })
  const randomBytes = vi.fn((size: number) => {
    const nonce = nonces[randomBytes.mock.calls.length - 1]
    const bytes = Buffer.from(nonce, 'hex')
    expect(size).toBe(32)
    return bytes
  })
  const controller = createWorkerController({
    workerEntry: WORKER_ENTRY,
    execPath: EXEC_PATH,
    parentPid: PARENT_PID,
    env: { ...BASE_ENV },
    fork,
    randomBytes,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    handshakeTimeoutMs: 100
  })
  return { children, controller, fork, forkCalls, randomBytes, timers }
}

function hello(child: FakeChild): Record<string, unknown> {
  const message = child.sent.find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === 'object' && candidate !== null && Reflect.get(candidate, 'type') === 'hello'
  )
  if (!message) throw new Error('worker hello was not sent')
  return message
}

function ready(child: FakeChild, nonce = String(hello(child).nonce)): void {
  child.emit('message', { version: 1, type: 'ready', nonce, pid: child.pid })
}

async function startReady(harness: ReturnType<typeof createHarness>): Promise<FakeChild> {
  const started = harness.controller.start()
  const child = harness.children.at(-1)
  if (!child) throw new Error('worker was not forked')
  ready(child)
  await started
  return child
}

function requestWithEnvelopeBytes(bytes: number) {
  const base = {
    version: 1,
    type: 'generate',
    id: 'boundary',
    modelPath: MODEL_PATH,
    prompt: '',
    maxTokens: 5
  }
  const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8')
  return {
    id: base.id,
    modelPath: base.modelPath,
    prompt: 'x'.repeat(bytes - baseBytes),
    maxTokens: base.maxTokens
  }
}

describe('createWorkerController', () => {
  it('exposes only the bounded lifecycle API', () => {
    const { controller } = createHarness()
    expect(Object.keys(controller).sort()).toEqual(
      ['cancel', 'dispose', 'forceKillForSelfTest', 'generate', 'start'].sort()
    )
  })

  it('forks a locked-down Electron-as-Node worker and sends the nonce only over IPC', async () => {
    const harness = createHarness()
    const child = await startReady(harness)

    expect(harness.fork).toHaveBeenCalledTimes(1)
    expect(harness.randomBytes).toHaveBeenCalledWith(32)
    expect(harness.forkCalls[0]).toMatchObject({
      modulePath: WORKER_ENTRY,
      args: [],
      options: {
        execPath: EXEC_PATH,
        execArgv: [],
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      }
    })
    const childEnv = harness.forkCalls[0].options.env as NodeJS.ProcessEnv
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(JSON.stringify(harness.forkCalls[0].args)).not.toContain(NONCE_1)
    expect(JSON.stringify(childEnv)).not.toContain(NONCE_1)
    expect(hello(child)).toEqual({
      version: 1,
      type: 'hello',
      nonce: NONCE_1,
      parentPid: PARENT_PID
    })
  })

  it('strips network, runtime-injection, provider, repository, and signing secrets', async () => {
    const harness = createHarness()
    await startReady(harness)
    const env = harness.forkCalls[0].options.env as NodeJS.ProcessEnv

    expect(env).toMatchObject({
      PATH: BASE_ENV.PATH,
      HOME: BASE_ENV.HOME,
      LANG: BASE_ENV.LANG,
      METIS_LOCAL_AI_DENY_NETWORK: '1'
    })
    for (const key of Object.keys(BASE_ENV).filter(
      (key) => !['PATH', 'HOME', 'LANG', 'METIS_LOCAL_AI_DENY_NETWORK'].includes(key)
    )) {
      expect(env[key], key).toBeUndefined()
    }
  })

  it('rejects and kills on a wrong nonce without waiting for the timeout', async () => {
    const harness = createHarness()
    const started = harness.controller.start()
    const child = harness.children[0]
    child.emit('message', { version: 1, type: 'ready', nonce: 'ff'.repeat(32), pid: child.pid })

    await expect(started).rejects.toThrow(/handshake/i)
    expect(child.killed).toBe(true)
  })

  it('kills and rejects when the handshake times out', async () => {
    const harness = createHarness()
    const started = harness.controller.start()
    const child = harness.children[0]
    harness.timers.fireAll()

    await expect(started).rejects.toThrow(/timeout/i)
    expect(child.killed).toBe(true)
  })

  it('accepts exactly the IPC byte cap and rejects one byte over without leaking content', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    expect(MAX_WORKER_IPC_BYTES).toBe(4 * 1024 * 1024)

    const atLimit = harness.controller.generate(requestWithEnvelopeBytes(MAX_WORKER_IPC_BYTES))
    const sent = child.sent.find(
      (message) => typeof message === 'object' && message !== null && Reflect.get(message, 'type') === 'generate'
    )
    expect(Buffer.byteLength(JSON.stringify(sent), 'utf8')).toBe(MAX_WORKER_IPC_BYTES)
    child.emit('message', {
      version: 1,
      type: 'done',
      id: 'boundary',
      tokenCount: 5,
      backend: 'metal',
      workerPath: WORKER_ENTRY,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    })
    await expect(atLimit).resolves.toEqual({
      tokenCount: 5,
      backend: 'metal',
      workerPath: WORKER_ENTRY,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    })

    const secret = 'SECRET_PROMPT_PAYLOAD'
    const over = requestWithEnvelopeBytes(MAX_WORKER_IPC_BYTES + 1)
    over.prompt = secret + over.prompt
    await expect(harness.controller.generate(over)).rejects.not.toThrow(secret)
  })

  it('rejects malformed child messages and terminates the worker', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    child.emit('message', { version: 1, type: 'token', id: 'none', text: 'x', extra: true })
    expect(child.killed).toBe(true)
  })

  it.each([
    { version: 1, type: 'token', id: 'unsolicited', text: 'x' },
    { version: 1, type: 'progress', id: 'unsolicited', generatedTokens: 1 },
    {
      version: 1,
      type: 'done',
      id: 'unsolicited',
      tokenCount: 1,
      backend: 'metal',
      workerPath: WORKER_ENTRY,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    },
    { version: 1, type: 'error', id: 'unsolicited', code: 'GENERATION_FAILED' },
    { version: 1, type: 'cancelled', id: 'unsolicited' }
  ])('fails closed on unsolicited worker output %#', async (message) => {
    const harness = createHarness()
    const child = await startReady(harness)

    child.emit('message', message)

    expect(child.killed).toBe(true)
  })

  it('fails closed on output for the wrong active generation', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    const generation = harness.controller.generate({
      id: 'expected',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    })
    const outcome = generation.catch((error: Error) => error)

    child.emit('message', { version: 1, type: 'token', id: 'different', text: 'x' })

    expect(child.killed).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/protocol/i) })
  })

  it('sends a typed cancel and suppresses later output for that generation', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    const onToken = vi.fn()
    const generation = harness.controller.generate(
      { id: 'cancel-me', modelPath: MODEL_PATH, prompt: 'hello', maxTokens: 10 },
      onToken
    )
    let cancelSettled = false
    void generation.catch(() => {
      cancelSettled = true
    })
    const cancelled = generation.then(
      () => null,
      (error: Error) => error
    )
    harness.controller.cancel('cancel-me')
    await Promise.resolve()

    expect(child.sent).toContainEqual({ version: 1, type: 'cancel', id: 'cancel-me' })
    expect(cancelSettled).toBe(false)
    await expect(
      harness.controller.generate({ id: 'too-soon', modelPath: MODEL_PATH, prompt: 'next', maxTokens: 5 })
    ).rejects.toThrow(/active generation/i)
    child.emit('message', { version: 1, type: 'token', id: 'cancel-me', text: 'late' })
    child.emit('message', { version: 1, type: 'progress', id: 'cancel-me', generatedTokens: 1 })
    expect(onToken).not.toHaveBeenCalled()

    child.emit('message', { version: 1, type: 'cancelled', id: 'cancel-me' })
    await expect(cancelled).resolves.toMatchObject({ message: expect.stringMatching(/cancel/i) })
    const next = harness.controller.generate({
      id: 'after-cancel',
      modelPath: MODEL_PATH,
      prompt: 'next',
      maxTokens: 5
    })
    expect(child.sent).toContainEqual(
      expect.objectContaining({ version: 1, type: 'generate', id: 'after-cancel' })
    )
    harness.controller.cancel('after-cancel')
    child.emit('message', { version: 1, type: 'cancelled', id: 'after-cancel' })
    await expect(next).rejects.toThrow(/cancel/i)
  })

  it('force-kills after a token and respawns once with a new pid and nonce', async () => {
    const harness = createHarness()
    const first = await startReady(harness)
    const onToken = vi.fn()
    const onProgress = vi.fn()
    const generation = harness.controller.generate(
      { id: 'probe', modelPath: MODEL_PATH, prompt: 'hello', maxTokens: 100 },
      onToken,
      onProgress
    )
    first.emit('message', { version: 1, type: 'progress', id: 'probe', generatedTokens: 2 })
    expect(onProgress).toHaveBeenCalledWith(2)
    expect(onToken).not.toHaveBeenCalled()

    const respawned = harness.controller.forceKillForSelfTest()
    expect(first.signal).toBe('SIGKILL')
    first.emit('message', { version: 1, type: 'progress', id: 'probe', generatedTokens: 3 })
    first.emit('message', { version: 1, type: 'token', id: 'probe', text: 'late secret' })
    first.emit('message', {
      version: 1,
      type: 'done',
      id: 'probe',
      tokenCount: 5,
      backend: 'metal',
      workerPath: WORKER_ENTRY,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    })
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onToken).not.toHaveBeenCalled()
    first.emit('exit', null, 'SIGKILL')
    const second = harness.children[1]
    expect(hello(second).nonce).toBe(NONCE_2)
    ready(second)

    await expect(respawned).resolves.toEqual({ previousPid: first.pid, pid: second.pid })
    await expect(generation).rejects.toThrow(/terminated/i)
    expect(second.pid).not.toBe(first.pid)
    expect(harness.fork).toHaveBeenCalledTimes(2)
  })

  it('refuses to force-kill an idle worker', async () => {
    const harness = createHarness()
    await startReady(harness)

    await expect(harness.controller.forceKillForSelfTest()).rejects.toThrow(/active generation/i)
    expect(harness.children[0].killed).toBe(false)
  })

  it.each([
    { version: 1, type: 'progress', id: 'probe', generatedTokens: 0 },
    { version: 1, type: 'progress', id: 'probe', generatedTokens: 4097 },
    { version: 1, type: 'progress', id: 'probe', generatedTokens: 1.5 },
    { version: 1, type: 'progress', id: 'bad id', generatedTokens: 1 },
    { version: 1, type: 'progress', id: 'probe', generatedTokens: 1, text: 'forbidden' }
  ])('fails closed on malformed content-free progress %#', async (message) => {
    const harness = createHarness()
    const child = await startReady(harness)
    void harness.controller.generate({
      id: 'probe',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    }).catch(() => undefined)

    child.emit('message', message)
    expect(child.killed).toBe(true)
  })

  it('fails closed when progress or final count exceeds the request token budget', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    const generation = harness.controller.generate({
      id: 'budget',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    })
    const outcome = generation.catch((error: Error) => error)

    child.emit('message', { version: 1, type: 'progress', id: 'budget', generatedTokens: 6 })
    expect(child.killed).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/protocol/i) })
  })

  it('rejects a final token count above the request budget', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    const generation = harness.controller.generate({
      id: 'done-budget',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    })
    const outcome = generation.catch((error: Error) => error)

    child.emit('message', {
      version: 1,
      type: 'done',
      id: 'done-budget',
      tokenCount: 6,
      backend: 'metal',
      workerPath: WORKER_ENTRY,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    })

    expect(child.killed).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/protocol/i) })
  })

  it('bounds cumulative streamed output across otherwise valid token messages', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    expect(MAX_WORKER_OUTPUT_BYTES).toBe(2 * 1024 * 1024)
    const generation = harness.controller.generate({
      id: 'output-cap',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 4096
    })
    const outcome = generation.catch((error: Error) => error)
    const chunk = 'x'.repeat(64 * 1024)

    for (let index = 0; index < 33 && !child.killed; index++) {
      child.emit('message', { version: 1, type: 'token', id: 'output-cap', text: chunk })
    }

    expect(child.killed).toBe(true)
    await expect(outcome).resolves.toMatchObject({ message: expect.stringMatching(/protocol/i) })
  })

  it('fails closed after the replacement worker exits and never loops', async () => {
    const harness = createHarness()
    const first = await startReady(harness)
    const generation = harness.controller.generate({
      id: 'before-second-crash',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 100
    })
    const respawned = harness.controller.forceKillForSelfTest()
    first.emit('exit', null, 'SIGKILL')
    const second = harness.children[1]
    ready(second)
    await respawned
    await expect(generation).rejects.toThrow(/terminated/i)

    second.emit('exit', 1, null)
    expect(harness.fork).toHaveBeenCalledTimes(2)
    await expect(
      harness.controller.generate({ id: 'after-crash', modelPath: MODEL_PATH, prompt: 'x', maxTokens: 5 })
    ).rejects.toThrow(/unavailable/i)
  })

  it('does not respawn on dispose and ignores late messages from the dead child', async () => {
    const harness = createHarness()
    const child = await startReady(harness)
    const onToken = vi.fn()
    const generation = harness.controller.generate(
      { id: 'late', modelPath: MODEL_PATH, prompt: 'hello', maxTokens: 5 },
      onToken
    )

    const disposing = harness.controller.dispose()
    expect(child.sent).toContainEqual({ version: 1, type: 'dispose' })
    child.emit('message', { version: 1, type: 'disposed' })
    await disposing
    child.emit('exit', null, 'SIGTERM')
    child.emit('message', { version: 1, type: 'token', id: 'late', text: 'secret output' })

    expect(harness.fork).toHaveBeenCalledTimes(1)
    expect(onToken).not.toHaveBeenCalled()
    await expect(generation).rejects.toThrow(/disposed/i)
  })
})
