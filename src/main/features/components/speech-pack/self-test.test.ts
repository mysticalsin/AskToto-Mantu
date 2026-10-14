import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PARAKEET_TDT_V3_INT8, WHISPER_BASE_Q8 } from './manifest'
import {
  recognitionMatchesFixture,
  readPinnedFixtureFile,
  runSpeechPackHostProtocol,
  speechPackHostEntryPath,
  type SpeechPackHostFork
} from './self-test'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('Unexpected real utility host in injected-host test')
    }
  }
}))

class MockHost {
  listeners = new Map<string, Array<(value: unknown) => void>>()
  messages: Record<string, unknown>[] = []
  messageWaiters: Array<{ count: number; resolve: () => void }> = []
  killed = false
  exitOnKill = true

  on(event: string, listener: (value: unknown) => void): this {
    const entries = this.listeners.get(event) ?? []
    entries.push(listener)
    this.listeners.set(event, entries)
    return this
  }

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message)
    for (const waiter of this.messageWaiters) {
      if (this.messages.length >= waiter.count) waiter.resolve()
    }
    this.messageWaiters = this.messageWaiters.filter((waiter) => this.messages.length < waiter.count)
  }

  waitForMessages(count: number): Promise<void> {
    if (this.messages.length >= count) return Promise.resolve()
    return new Promise((resolve) => this.messageWaiters.push({ count, resolve }))
  }

  kill(): void {
    this.killed = true
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', 0))
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

const run = (
  host: MockHost,
  options: Partial<{ startupTimeoutMs: number; recognitionTimeoutMs: number; teardownTimeoutMs: number }> = {}
) =>
  runSpeechPackHostProtocol({
    componentId: WHISPER_BASE_Q8.id,
    packDir: '/pack',
    pcm: new ArrayBuffer(16),
    signal: new AbortController().signal,
    fork: (() => host) as SpeechPackHostFork,
    ...options
  })

describe('speech-pack utility host protocol', () => {
  it('reads a pinned fixture within its exact byte bound and rejects oversized files before opening', async () => {
    const root = mkdtempSync(join(tmpdir(), 'speech-pack-fixture-'))
    const validPath = join(root, 'valid.wav')
    const oversizedPath = join(root, 'oversized.wav')
    const bytes = Buffer.from('small deterministic WAV fixture')
    const pin = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    writeFileSync(validPath, bytes)
    writeFileSync(oversizedPath, Buffer.concat([bytes, Buffer.alloc(1_000_000)]))
    try {
      await expect(readPinnedFixtureFile(validPath, pin)).resolves.toEqual(bytes)
      const open = vi.spyOn(fsPromises, 'open')
      try {
        await expect(readPinnedFixtureFile(oversizedPath, pin)).rejects.toThrow('does not match its pin')
        expect(open).not.toHaveBeenCalled()
      } finally {
        open.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    'Ask not what your country can do for you, ask what you can do for your country.',
    'ASK NOT WHAT YOUR COUNTRY CAN DO FOR YOU—ASK WHAT YOU CAN DO FOR YOUR COUNTRY!',
    'Um, ask not what your country can do for you; ask what you can do for your country.'
  ])('accepts a plausible normalized rendition of the pinned fixture: %s', (text) => {
    expect(recognitionMatchesFixture(text)).toBe(true)
  })

  it.each([
    '',
    'ok',
    'ask not what your country can',
    'ask not what your country can do for you ask what you can do for your',
    'This unrelated speech is clear and complete.'
  ])('rejects empty, short, prefix-only and unrelated recognition: %s', (text) => {
    expect(recognitionMatchesFixture(text)).toBe(false)
  })

  it('uses the packaged sibling host, sends fixture audio, accepts the correlated result and waits for exit', async () => {
    const host = new MockHost()
    expect(speechPackHostEntryPath('/app/out/main', WHISPER_BASE_Q8.id)).toBe(
      join('/app/out/main', 'whisper-asr-host.js')
    )
    expect(speechPackHostEntryPath('/app/out/main', PARAKEET_TDT_V3_INT8.id)).toBe(
      join('/app/out/main', 'parakeet-asr-host.js')
    )
    const result = run(host)
    await host.waitForMessages(1)
    expect(host.messages[0]).toMatchObject({ type: 'init', modelsPath: '/pack' })
    host.emit('message', { type: 'ready' })
    await host.waitForMessages(2)
    expect(host.messages[1]).toMatchObject({ type: 'transcribe', id: 1 })
    const transcript = 'Ask not what your country can do for you, ask what you can do for your country.'
    host.emit('message', { type: 'result', id: 1, text: transcript })
    await expect(result).resolves.toBe(transcript)
    expect(host.killed).toBe(true)
  })

  it('uses the existing Parakeet warmup and recognition messages', async () => {
    const host = new MockHost()
    const result = runSpeechPackHostProtocol({
      componentId: PARAKEET_TDT_V3_INT8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: new AbortController().signal,
      fork: (() => host) as SpeechPackHostFork
    })
    await host.waitForMessages(1)
    expect(host.messages[0]).toMatchObject({ type: 'warmup', id: 'speech-pack-startup' })
    host.emit('message', { type: 'result', id: 'speech-pack-startup' })
    await host.waitForMessages(2)
    expect(host.messages[1]).toMatchObject({ type: 'transcribe', id: 'speech-pack-self-test' })
    host.emit('message', {
      type: 'result',
      id: 'speech-pack-self-test',
      text: 'Ask not what your country can do for you, ask what you can do for your country.'
    })
    await expect(result).resolves.toContain('Ask not what your country')
  })

  it('fails closed on malformed or unrelated recognition results', async () => {
    const host = new MockHost()
    const result = run(host)
    await host.waitForMessages(1)
    host.emit('message', { type: 'ready' })
    host.emit('message', { type: 'result', id: 999, text: 'unrelated' })
    host.emit('message', { type: 'result', id: 1, text: '  ' })
    await expect(result).rejects.toThrow('did not match its phrase')
    expect(host.killed).toBe(true)
  })

  it('tears down on utility-host errors and startup timeout', async () => {
    const failedHost = new MockHost()
    const failed = run(failedHost)
    await failedHost.waitForMessages(1)
    failedHost.emit('message', { type: 'error', message: 'private native detail' })
    await expect(failed).rejects.toThrow('Speech-pack recognition failed')
    expect(failedHost.killed).toBe(true)

    const startupHost = new MockHost()
    const startup = run(startupHost, { startupTimeoutMs: 10 })
    await startupHost.waitForMessages(1)
    await expect(startup).rejects.toThrow('failed to start in time')
    expect(startupHost.killed).toBe(true)
  })

  it('tears down on decode timeout and cancellation', async () => {
    const timeoutHost = new MockHost()
    const timeout = run(timeoutHost, { recognitionTimeoutMs: 10 })
    await timeoutHost.waitForMessages(1)
    timeoutHost.emit('message', { type: 'ready' })
    await expect(timeout).rejects.toThrow('self-test timed out')
    expect(timeoutHost.killed).toBe(true)

    const cancelHost = new MockHost()
    const controller = new AbortController()
    const cancelled = runSpeechPackHostProtocol({
      componentId: WHISPER_BASE_Q8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: controller.signal,
      fork: (() => cancelHost) as SpeechPackHostFork
    })
    await cancelHost.waitForMessages(1)
    cancelHost.emit('message', { type: 'ready' })
    controller.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(cancelHost.killed).toBe(true)
  })

  it('does not post initialization after cancellation during host creation', async () => {
    const host = new MockHost()
    const controller = new AbortController()
    const cancelled = runSpeechPackHostProtocol({
      componentId: WHISPER_BASE_Q8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: controller.signal,
      fork: (() => {
        controller.abort()
        return host
      }) as SpeechPackHostFork
    })
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(host.messages).toEqual([])
    expect(host.killed).toBe(true)
  })

  it('claims the host slot before another concurrent self-test can fork', async () => {
    const firstHost = new MockHost()
    const secondHost = new MockHost()
    let forkCount = 0
    const fork = (() => (forkCount++ === 0 ? firstHost : secondHost)) as SpeechPackHostFork
    const firstController = new AbortController()
    const first = runSpeechPackHostProtocol({
      componentId: WHISPER_BASE_Q8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: firstController.signal,
      fork
    })
    const second = runSpeechPackHostProtocol({
      componentId: PARAKEET_TDT_V3_INT8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: new AbortController().signal,
      fork
    })
    await firstHost.waitForMessages(1)
    await expect(second).rejects.toThrow('already running')
    expect(forkCount).toBe(1)
    firstController.abort()
    await expect(first).rejects.toThrow('cancelled')
  })

  it('does not replace a host whose kill did not produce exit until its actual exit event', async () => {
    const lingering = new MockHost()
    lingering.exitOnKill = false
    const replacement = new MockHost()
    let forks = 0
    const fork = (() => (forks++ === 0 ? lingering : replacement)) as SpeechPackHostFork
    const result = runSpeechPackHostProtocol({
      componentId: PARAKEET_TDT_V3_INT8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: new AbortController().signal,
      fork,
      recognitionTimeoutMs: 10,
      teardownTimeoutMs: 1
    })
    await lingering.waitForMessages(1)
    lingering.emit('message', { type: 'result', id: 'speech-pack-startup' })
    await lingering.waitForMessages(2)
    lingering.emit('message', {
      type: 'result',
      id: 'speech-pack-self-test',
      text: 'Ask not what your country can do for you, ask what you can do for your country.'
    })
    try {
      await expect(result).rejects.toThrow('did not stop')
      await expect(
        runSpeechPackHostProtocol({
          componentId: WHISPER_BASE_Q8.id,
          packDir: '/pack',
          pcm: new ArrayBuffer(16),
          signal: new AbortController().signal,
          fork,
          teardownTimeoutMs: 1
        })
      ).rejects.toThrow('still stopping')
      expect(forks).toBe(1)
    } finally {
      lingering.emit('exit', 0)
    }
    const afterExit = runSpeechPackHostProtocol({
      componentId: WHISPER_BASE_Q8.id,
      packDir: '/pack',
      pcm: new ArrayBuffer(16),
      signal: new AbortController().signal,
      fork
    })
    await replacement.waitForMessages(1)
    replacement.emit('message', { type: 'ready' })
    replacement.emit('message', {
      type: 'result',
      id: 1,
      text: 'Ask not what your country can do for you, ask what you can do for your country.'
    })
    await expect(afterExit).resolves.toContain('Ask not what your country')
    expect(forks).toBe(2)
  })
})
