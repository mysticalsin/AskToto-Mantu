import { describe, expect, it, vi } from 'vitest'
import { acquireManagedUtilityHost, type UtilityHostFork, type UtilityHostPort } from './speech-pack-host'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('Unexpected real utility host in injected-host test')
    }
  }
}))

class FakeHost implements UtilityHostPort {
  listeners = new Map<string, Array<(value: unknown) => void>>()
  killed = false
  exitOnKill = true
  throwOnKill = false

  on(event: 'message', listener: (value: unknown) => void): this
  on(event: 'exit', listener: (value: number | null) => void): this
  on(event: 'message' | 'exit', listener: ((value: unknown) => void) | ((value: number | null) => void)): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener as (value: unknown) => void)
    this.listeners.set(event, listeners)
    return this
  }

  postMessage(_message: Record<string, unknown>): void {}

  kill(): void {
    this.killed = true
    if (this.throwOnKill) throw new Error('kill failed')
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', 0))
  }

  emit(event: 'message' | 'exit', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value)
  }
}

const forkFor = (host: FakeHost): UtilityHostFork => (() => host) as UtilityHostFork

describe('owned utility host lifecycle', () => {
  it('claims the process slot before returning a lease and releases only on actual exit', async () => {
    const host = new FakeHost()
    const lease = await acquireManagedUtilityHost({
      path: '/bundle/helper.js',
      serviceName: 'test-helper',
      fork: forkFor(host)
    })
    await expect(
      acquireManagedUtilityHost({ path: '/bundle/other.js', serviceName: 'other', fork: forkFor(new FakeHost()) })
    ).rejects.toThrow('already running')

    host.exitOnKill = false
    host.throwOnKill = true
    await expect(lease.stop(1)).rejects.toThrow('did not stop')
    await expect(
      acquireManagedUtilityHost({
        path: '/bundle/other.js',
        serviceName: 'other',
        fork: forkFor(new FakeHost()),
        waitForExitMs: 1
      })
    ).rejects.toThrow('still stopping')

    host.emit('exit', 0)
    const replacement = new FakeHost()
    const next = await acquireManagedUtilityHost({
      path: '/bundle/other.js',
      serviceName: 'other',
      fork: forkFor(replacement)
    })
    expect(next.didExit).toBe(false)
    await next.stop(10)
    expect(replacement.killed).toBe(true)
  })

  it('releases a claimed slot when fork throws and never forks for an aborted admission', async () => {
    const failure = await acquireManagedUtilityHost({
      path: '/bundle/fail.js',
      serviceName: 'failure',
      fork: (() => {
        throw new Error('fork failed')
      }) as UtilityHostFork
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ message: 'fork failed' })

    const controller = new AbortController()
    controller.abort()
    const fork = vi.fn(() => new FakeHost()) as unknown as UtilityHostFork
    await expect(
      acquireManagedUtilityHost({
        path: '/bundle/aborted.js',
        serviceName: 'aborted',
        signal: controller.signal,
        fork
      })
    ).rejects.toThrow('cancelled')
    expect(fork).not.toHaveBeenCalled()

    const host = new FakeHost()
    const lease = await acquireManagedUtilityHost({ path: '/bundle/ok.js', serviceName: 'ok', fork: forkFor(host) })
    await lease.stop(10)
  })

  it('cancels a replacement admission while the previous host exit barrier is unresolved', async () => {
    const host = new FakeHost()
    host.exitOnKill = false
    const lease = await acquireManagedUtilityHost({ path: '/bundle/old.js', serviceName: 'old', fork: forkFor(host) })
    const stopping = lease.stop(100)
    const controller = new AbortController()
    const replacementFork = vi.fn(() => new FakeHost()) as unknown as UtilityHostFork
    const replacement = acquireManagedUtilityHost({
      path: '/bundle/new.js',
      serviceName: 'new',
      signal: controller.signal,
      fork: replacementFork
    })
    controller.abort()
    await expect(replacement).rejects.toThrow('cancelled')
    expect(replacementFork).not.toHaveBeenCalled()
    host.emit('exit', 0)
    await expect(stopping).resolves.toBeUndefined()
  })
})
