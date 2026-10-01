import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractParakeetArchiveWindows } from './parakeet-extract'

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn()
  readonly kill = vi.fn(() => true)
  readonly stderr = new EventEmitter()
  readonly stdout = new EventEmitter()
}

describe('Windows Parakeet recovery extraction', () => {
  afterEach(() => vi.useRealTimers())

  it('runs archive extraction outside the Electron main process', async () => {
    const child = new FakeChild()
    const fork = vi.fn(() => child as never)
    const extraction = extractParakeetArchiveWindows('C:\\Metis\\parakeet.tar.bz2', 'C:\\Metis\\staging', {
      fork,
      timeoutMs: 1_000
    })

    expect(fork).toHaveBeenCalledOnce()
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'extract',
      archivePath: 'C:\\Metis\\parakeet.tar.bz2',
      destDir: 'C:\\Metis\\staging'
    })
    child.emit('message', { type: 'result' })

    await expect(extraction).resolves.toBeUndefined()
  })

  it('turns a wedged helper into a recoverable timeout instead of leaving onboarding blocked', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const extraction = extractParakeetArchiveWindows('archive.tar.bz2', 'staging', {
      fork: () => child as never,
      timeoutMs: 100
    })
    const rejection = expect(extraction).rejects.toThrow(/timed out/i)

    await vi.advanceTimersByTimeAsync(100)

    expect(child.kill).toHaveBeenCalledOnce()
    await rejection
  })

  it('fails instead of waiting forever when the helper exits before reporting a result', async () => {
    const child = new FakeChild()
    const extraction = extractParakeetArchiveWindows('archive.tar.bz2', 'staging', {
      fork: () => child as never,
      timeoutMs: 1_000
    })

    child.emit('exit', 1)

    await expect(extraction).rejects.toThrow(/exited/i)
  })
})
