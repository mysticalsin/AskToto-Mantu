import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runWorkerProcess } from './index.mjs'

const MODEL_PATH = '/detached/Metis.app/Contents/Resources/local-ai/text/model.gguf'
const WORKER_PATH = '/detached/Metis.app/Contents/Resources/app.asar/out/local-ai-worker/index.mjs'
const MODULE_PATH = '/detached/Metis.app/Contents/Resources/app.asar/node_modules/node-llama-cpp/dist/index.js'
const BINDING_PATH = '/detached/Metis.app/Contents/Resources/app.asar.unpacked/node_modules/@node-llama-cpp/mac-arm64-metal/bins/mac-arm64-metal/llama-addon.node'

class FakeChannel extends EventEmitter {
  readonly sent: unknown[] = []
  readonly exit = vi.fn()
  readonly pid = 2222
  connected = true

  send(message: unknown): boolean {
    this.sent.push(message)
    return true
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function harness() {
  const order: string[] = []
  const channel = new FakeChannel()
  const runtime = {
    backend: 'metal' as const,
    modulePath: MODULE_PATH,
    bindingPath: BINDING_PATH,
    generate: vi.fn(async ({
      onTextChunk,
      onGeneratedTokens
    }: {
      onTextChunk: (text: string) => void
      onGeneratedTokens: (count: number) => void
    }) => {
      onGeneratedTokens(2)
      onTextChunk('one')
      return { text: 'one two three four five', tokenCount: 5 }
    }),
    dispose: vi.fn(async () => {
      order.push('dispose')
    })
  }
  const guard = { attempts: vi.fn(() => 0), restore: vi.fn() }
  const installNetworkDeny = vi.fn(() => {
    order.push('deny')
    return guard
  })
  const createNativeRuntime = vi.fn(async () => {
    order.push('runtime')
    return runtime
  })
  runWorkerProcess({
    channel,
    platform: 'darwin',
    workerPath: WORKER_PATH,
    installNetworkDeny,
    createNativeRuntime
  })
  return { channel, createNativeRuntime, guard, installNetworkDeny, order, runtime }
}

function hello(channel: FakeChannel): void {
  channel.emit('message', {
    version: 1,
    type: 'hello',
    nonce: 'ab'.repeat(32),
    parentPid: 1111
  })
}

describe('runWorkerProcess', () => {
  it('installs network denial before acknowledging or initializing native code', async () => {
    const value = harness()
    expect(value.order).toEqual(['deny'])
    hello(value.channel)
    await tick()

    expect(value.channel.sent[0]).toEqual({
      version: 1,
      type: 'ready',
      nonce: 'ab'.repeat(32),
      pid: value.channel.pid
    })
    expect(value.createNativeRuntime).not.toHaveBeenCalled()
  })

  it('loads the passed local model, streams tokens, and returns runtime proof only', async () => {
    const value = harness()
    hello(value.channel)
    value.channel.emit('message', {
      version: 1,
      type: 'generate',
      id: 'probe',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    })
    await tick()

    expect(value.order).toEqual(['deny', 'runtime'])
    expect(value.createNativeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: MODEL_PATH, platform: 'darwin' })
    )
    expect(value.channel.sent).toContainEqual({
      version: 1,
      type: 'progress',
      id: 'probe',
      generatedTokens: 2
    })
    expect(value.channel.sent).toContainEqual({ version: 1, type: 'token', id: 'probe', text: 'one' })
    expect(value.channel.sent).toContainEqual({
      version: 1,
      type: 'done',
      id: 'probe',
      tokenCount: 5,
      backend: 'metal',
      workerPath: WORKER_PATH,
      modulePath: MODULE_PATH,
      bindingPath: BINDING_PATH,
      networkAttempts: 0
    })
    expect(JSON.stringify(value.channel.sent)).not.toContain('one two three four five')
    expect(JSON.stringify(value.channel.sent)).not.toContain('private thought segment')
  })

  it('aborts the active generation without emitting late content', async () => {
    const value = harness()
    value.runtime.generate.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
    )
    hello(value.channel)
    value.channel.emit('message', {
      version: 1,
      type: 'generate',
      id: 'cancel-me',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 128
    })
    await tick()
    value.channel.emit('message', { version: 1, type: 'cancel', id: 'cancel-me' })
    await tick()

    expect(value.channel.sent.some((message) => Reflect.get(Object(message), 'type') === 'error')).toBe(false)
    expect(value.channel.sent.some((message) => Reflect.get(Object(message), 'type') === 'done')).toBe(false)
    expect(value.channel.sent).toContainEqual({ version: 1, type: 'cancelled', id: 'cancel-me' })

    value.runtime.generate.mockResolvedValueOnce({ text: 'next', tokenCount: 1 })
    value.channel.emit('message', {
      version: 1,
      type: 'generate',
      id: 'after-cancel',
      modelPath: MODEL_PATH,
      prompt: 'next',
      maxTokens: 1
    })
    await tick()
    expect(value.channel.sent).toContainEqual(expect.objectContaining({ type: 'done', id: 'after-cancel' }))
  })

  it('disposes and exits when the parent IPC channel disconnects', async () => {
    const value = harness()
    hello(value.channel)
    value.channel.emit('disconnect')
    await tick()

    expect(value.runtime.dispose).not.toHaveBeenCalled()
    expect(value.guard.restore).toHaveBeenCalledTimes(1)
    expect(value.channel.exit).toHaveBeenCalledWith(0)
  })

  it('disposes an initialized runtime before exiting on disconnect', async () => {
    const value = harness()
    hello(value.channel)
    value.channel.emit('message', {
      version: 1,
      type: 'generate',
      id: 'load',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 5
    })
    await tick()
    value.channel.emit('disconnect')
    await tick()

    expect(value.runtime.dispose).toHaveBeenCalledTimes(1)
    expect(value.guard.restore).toHaveBeenCalledTimes(1)
    expect(value.channel.exit).toHaveBeenCalledWith(0)
  })

  it('waits for active generation to unwind before disposing native state', async () => {
    const value = harness()
    value.runtime.generate.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              value.order.push('abort')
              setImmediate(() => {
                value.order.push('settled')
                resolve({ text: '', tokenCount: 0 })
              })
            },
            { once: true }
          )
        })
    )
    hello(value.channel)
    value.channel.emit('message', {
      version: 1,
      type: 'generate',
      id: 'active-on-disconnect',
      modelPath: MODEL_PATH,
      prompt: 'hello',
      maxTokens: 128
    })
    await tick()

    value.channel.emit('disconnect')
    await tick()
    await tick()

    expect(value.order.indexOf('abort')).toBeLessThan(value.order.indexOf('settled'))
    expect(value.order.indexOf('settled')).toBeLessThan(value.order.indexOf('dispose'))
    expect(value.channel.exit).toHaveBeenCalledWith(0)
  })

  it('fails closed on malformed or oversized parent messages', async () => {
    const value = harness()
    hello(value.channel)
    value.channel.emit('message', { version: 1, type: 'cancel', id: 'x', extra: true })
    await tick()

    expect(value.channel.exit).toHaveBeenCalledWith(1)
  })
})
