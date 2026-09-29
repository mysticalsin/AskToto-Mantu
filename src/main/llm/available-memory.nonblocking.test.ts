import { afterEach, describe, expect, it, vi } from 'vitest'

const GB = 1024 ** 3
const PAGE = 16_384
const pages = (gb: number): number => Math.round((gb * GB) / PAGE)
const VM_STAT_32GB = [
  `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)`,
  `Pages free:                               ${pages(0.45)}.`,
  `Pages inactive:                          ${pages(9.5)}.`,
  `Pages speculative:                        ${pages(0.3)}.`,
  `Pages purgeable:                          ${pages(0.6)}.`,
  ''
].join('\n')

const child = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('execFileSync on the main thread') }),
  spawnSync: vi.fn(() => { throw new Error('spawnSync on the main thread') }),
  execSync: vi.fn(() => { throw new Error('execSync on the main thread') })
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  ...child
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  freemem: () => 0.45 * GB
}))

import { availableMemoryGB, refreshVmStatReading, startAvailableMemorySampler } from './available-memory'

afterEach(() => vi.useRealTimers())

describe('availableMemoryGB() never blocks the main thread on vm_stat (M2-0430, M2-0422 class)', () => {
  it('answers synchronously from a background reading and never calls a sync spawn', async () => {
    const stalled: Array<(error: Error | null, stdout: string) => void> = []
    child.execFile.mockImplementation((_file, _args, _opts, callback) => { stalled.push(callback) })

    // No reading yet: the answer is freemem() (errs small) and vm_stat has only been started, not awaited.
    expect(availableMemoryGB('darwin')).toBeCloseTo(0.45)
    expect(child.execFile).toHaveBeenCalledTimes(1)
    expect(child.execFile.mock.calls[0][0]).toBe('/usr/bin/vm_stat')

    // A second caller while vm_stat is still stalled shares the in-flight run and still returns at once.
    expect(availableMemoryGB('darwin')).toBeCloseTo(0.45)
    expect(child.execFile).toHaveBeenCalledTimes(1)

    const pending = refreshVmStatReading()
    stalled[0](null, VM_STAT_32GB)
    await pending
    expect(availableMemoryGB('darwin')).toBeGreaterThan(10.5)
    expect(child.execFile).toHaveBeenCalledTimes(1) // fresh reading: no new run

    expect(child.execFileSync).not.toHaveBeenCalled()
    expect(child.spawnSync).not.toHaveBeenCalled()
    expect(child.execSync).not.toHaveBeenCalled()
  })

  it('the boot sampler refreshes every 10 s on darwin, and a failed run falls back to freemem()', async () => {
    vi.useFakeTimers()
    child.execFile.mockReset()
    child.execFile.mockImplementation((_file, _args, _opts, callback) => callback(new Error('timeout'), ''))
    const stop = startAvailableMemorySampler('darwin')
    expect(child.execFile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.execFile).toHaveBeenCalledTimes(2)
    stop()
    // The earlier 32 GB reading was dropped by the failed run rather than trusted while stale.
    expect(availableMemoryGB('darwin')).toBeCloseTo(0.45)
    expect(child.execFileSync).not.toHaveBeenCalled()

    child.execFile.mockReset()
    expect(startAvailableMemorySampler('win32')).toBeTypeOf('function')
    expect(child.execFile).not.toHaveBeenCalled()
  })
})
