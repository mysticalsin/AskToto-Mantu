import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { join, relative } from 'node:path'

vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn(() => null) }))

import { createFifo, releaseFifo } from '../../../../scripts/qa/fixtures/fifo.mjs'
import { createStorageGateway, threadpoolSize } from './gateway'
import type { ContentPresence } from './dataless'

async function releaseUntilSettled(fifos: readonly string[], pending: Promise<unknown>): Promise<void> {
  let settled = false
  void pending.finally(() => {
    settled = true
  })
  while (!settled) {
    for (const fifo of fifos) releaseFifo(fifo)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe.skipIf(process.platform === 'win32')('kernel-blocking pool protection (K0-K2, POSIX)', () => {
  const pool = threadpoolSize(process.env.UV_THREADPOOL_SIZE)
  let dir: string

  beforeEach(() => {
    vi.useRealTimers()
    dir = mkdtempSync(join(tmpdir(), 'gateway-fifo-'))
  })

  afterEach(() => {
    for (const name of readdirSync(dir)) releaseFifo(join(dir, name))
    rmSync(dir, { recursive: true, force: true })
  })

  it('the fixture is real: pool + 2 direct reads of FIFOs leave dns.lookup waiting', async () => {
    const { readFile } = await import('node:fs/promises')
    const fifos = Array.from({ length: pool + 2 }, (_, i) => join(dir, `direct-${i}`))
    for (const fifo of fifos) createFifo(fifo)

    const reads = Promise.all(fifos.map((fifo) => readFile(fifo)))
    let lookupResolved = false
    const lookupDone = lookup('localhost').then((value) => {
      lookupResolved = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(lookupResolved).toBe(false) // the pool is fully pinned by direct FIFO reads

    await releaseUntilSettled(fifos, reads)
    await lookupDone
  }, 20_000)

  it('through the gateway, six blocked reads leave dns.lookup, an async write and the event loop responsive', async () => {
    const meetingsRoot = mkdtempSync(join(tmpdir(), 'gateway-fifo-root-'))
    const brainEntities = join(meetingsRoot, '.brain', 'entities', 'person')
    mkdirSync(brainEntities, { recursive: true })

    const fifoPaths = [
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-1.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-2.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-3.md'),
      join(meetingsRoot, '2026-01-01_090000-st1-fifo-4.md'),
      join(meetingsRoot, '.brain', 'index.json'),
      join(brainEntities, 'x.json')
    ]
    for (const fifo of fifoPaths) createFifo(fifo)

    try {
      const relPaths = fifoPaths.map((path) => relative(meetingsRoot, path))
      const gateway = createStorageGateway({
        root: () => meetingsRoot,
        detector: {
          classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local']))
        },
        poolSize: pool
      })

      const loop = monitorEventLoopDelay({ resolution: 10 })
      loop.enable()

      const reads = Promise.all(relPaths.map((rel) => gateway.read(rel)))
      await new Promise((resolve) => setTimeout(resolve, 100))

      const writeDir = mkdtempSync(join(tmpdir(), 'gateway-fifo-write-'))
      try {
        const writeStarted = performance.now()
        await writeFile(join(writeDir, 'probe.txt'), 'x')
        expect(performance.now() - writeStarted).toBeLessThan(250)

        const lookupStarted = performance.now()
        await lookup('localhost')
        expect(performance.now() - lookupStarted).toBeLessThan(250)

        expect(loop.percentile(99) / 1e6).toBeLessThan(50)
      } finally {
        loop.disable()
        rmSync(writeDir, { recursive: true, force: true })
      }

      await releaseUntilSettled(fifoPaths, reads)
      const results = await reads
      for (const result of results) {
        expect(result.status).toBe('ok')
        if (result.status === 'ok') expect(result.bytes.length).toBe(0)
      }
    } finally {
      for (const fifo of fifoPaths) releaseFifo(fifo)
      rmSync(meetingsRoot, { recursive: true, force: true })
    }
  }, 20_000)

  it('a FIFO the detector calls dataless is answered at once and never opened', async () => {
    const fifo = join(dir, 'cloud-fifo.md')
    createFifo(fifo)

    const gateway = createStorageGateway({
      root: () => dir,
      detector: {
        classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'dataless']))
      },
      poolSize: pool
    })
    const result = await gateway.read('cloud-fifo.md')

    expect(result).toMatchObject({ status: 'dataless' })
    expect(releaseFifo(fifo)).toBe(false) // nobody was ever waiting to open it
  })
})
