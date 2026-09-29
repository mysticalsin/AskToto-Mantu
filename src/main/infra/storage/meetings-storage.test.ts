import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn(() => null) }))

import { createFifo, releaseFifo } from '../../../../scripts/qa/fixtures/fifo.mjs'
import { threadpoolSize } from './gateway'
import { storageAt, useStorageForTests } from './meetings-storage'

describe.skipIf(process.platform === 'win32')('storageAt shares one admission across roots', () => {
  const pool = threadpoolSize(process.env.UV_THREADPOOL_SIZE)
  const perRoot = Math.max(1, pool - 2)
  let rootA: string
  let rootB: string
  let fifos: string[]

  beforeEach(() => {
    useStorageForTests()
    rootA = mkdtempSync(join(tmpdir(), 'meetings-storage-a-'))
    rootB = mkdtempSync(join(tmpdir(), 'meetings-storage-b-'))
    fifos = []
  })

  afterEach(() => {
    for (const fifo of fifos) releaseFifo(fifo)
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  })

  it('blocked reads under three root spellings leave the async write, dns.lookup and two pool threads free', async () => {
    const roots = [
      { root: rootA, dir: rootA, prefix: 'a' },
      { root: rootB, dir: rootB, prefix: 'b' },
      { root: rootA + sep, dir: rootA, prefix: 'c' }
    ]
    const reads: Promise<unknown>[] = []
    for (const { root, dir, prefix } of roots) {
      for (let i = 0; i < perRoot; i += 1) {
        const name = `2026-01-01_090000-${prefix}-${i}.md`
        const fifo = join(dir, name)
        createFifo(fifo)
        fifos.push(fifo)
        reads.push(storageAt(root).read(name))
      }
    }
    const settled = Promise.all(reads)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const writeDir = mkdtempSync(join(tmpdir(), 'meetings-storage-write-'))
    try {
      const writeStarted = performance.now()
      await writeFile(join(writeDir, 'probe.txt'), 'x')
      expect(performance.now() - writeStarted).toBeLessThan(250)

      const lookupStarted = performance.now()
      await lookup('localhost')
      expect(performance.now() - lookupStarted).toBeLessThan(250)
    } finally {
      rmSync(writeDir, { recursive: true, force: true })
    }

    // One synchronous pass: a woken read opens its next file only on a later turn of the event loop.
    const opened = fifos.filter((fifo) => releaseFifo(fifo)).length
    expect(opened).toBeGreaterThan(0)
    expect(opened).toBeLessThanOrEqual(perRoot)

    let done = false
    void settled.finally(() => {
      done = true
    })
    while (!done) {
      for (const fifo of fifos) releaseFifo(fifo)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }, 20_000)

  it('two spellings of one folder get the same gateway', () => {
    expect(storageAt(rootA + sep)).toBe(storageAt(rootA))
    expect(storageAt(rootB)).not.toBe(storageAt(rootA))
  })
})
