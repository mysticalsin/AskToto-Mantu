import { appendFileSync, closeSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { atomicSavedWriteStream } from './atomic-saved-write'

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, randomBytes: vi.fn((size: number) => Buffer.alloc(size, 0xab)) }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metis-stream-write-'))
  roots.push(root)
  return root
}

async function* byteChunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Uint8Array.from(Buffer.from(value, 'utf8'))
}

const bounds = { maxBytes: 16, maxChunkBytes: 8, maxChunks: 4 }

describe('atomic streamed saved write', () => {
  it('writes bounded owned chunks in order and replaces only after the stream closes', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')
    const checks: string[] = []

    await atomicSavedWriteStream(target, byteChunks('hello ', 'world'), {
      ...bounds,
      beforeChunk: () => checks.push('chunk'),
      beforeReplace: () => checks.push('replace')
    })

    expect(await readFile(target, 'utf8')).toBe('hello world')
    expect(checks.filter((item) => item === 'replace')).toHaveLength(1)
    expect((await readdir(root)).sort()).toEqual(['meeting.md'])
  })

  it('does not replace when authority expires between yielded chunks', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')
    let current = true

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from(Buffer.from('first'))
      current = false
      yield Uint8Array.from(Buffer.from('second'))
    }

    await expect(
      atomicSavedWriteStream(target, chunks(), {
        ...bounds,
        beforeChunk: () => {
          if (!current) throw new Error('STALE_OWNER')
        }
      })
    ).rejects.toThrow('STALE_OWNER')

    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual([basename(target)])
  })

  it('preserves the old file on total, chunk, or chunk-count limit refusal', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')

    await expect(
      atomicSavedWriteStream(target, byteChunks('123456789'), { ...bounds, maxChunkBytes: 8 })
    ).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    await expect(atomicSavedWriteStream(target, byteChunks('12345678', '12345678', 'x'), bounds)).rejects.toMatchObject(
      { name: 'RESOURCE_LIMIT' }
    )
    await expect(
      atomicSavedWriteStream(target, byteChunks('a', 'b', 'c', 'd', 'e'), { ...bounds, maxChunks: 4 })
    ).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })

    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual([basename(target)])
  })

  it('requires each producer chunk to be an exact owned fixed ArrayBuffer', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')
    const backing = new Uint8Array(4)
    const view = backing.subarray(1)

    await expect(
      atomicSavedWriteStream(
        target,
        (async function* () {
          yield view
        })(),
        bounds
      )
    ).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    expect(await readFile(target, 'utf8')).toBe('old')
  })

  it('does not unlink a colliding temp path that it failed to create', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    const collision = `${target}.${'ab'.repeat(12)}.tmp`
    await writeFile(target, 'old')
    await writeFile(collision, 'foreign temp')

    await expect(atomicSavedWriteStream(target, byteChunks('new'), bounds)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readFile(collision, 'utf8')).toBe('foreign temp')
  })

  it('keeps the admitted byte and chunk limits when the caller mutates its options', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    const mutable = { maxBytes: 1, maxChunkBytes: 1, maxChunks: 1 }

    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Uint8Array.from(Buffer.from('a'))
      mutable.maxBytes = Number.POSITIVE_INFINITY
      mutable.maxChunkBytes = Number.POSITIVE_INFINITY
      mutable.maxChunks = 100
      yield Uint8Array.from(Buffer.from('b'))
    }

    await expect(atomicSavedWriteStream(target, chunks(), mutable)).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    expect(await readdir(root)).toEqual([])
  })

  it('does not trust overridable typed-array metadata accessors', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    const backing = Uint8Array.from(Buffer.from('xx'))
    const view = backing.subarray(1)
    Object.defineProperties(view, {
      byteOffset: { configurable: true, get: () => 0 },
      byteLength: { configurable: true, get: () => backing.byteLength }
    })

    await expect(
      atomicSavedWriteStream(
        target,
        (async function* () {
          yield view
        })(),
        bounds
      )
    ).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
    expect(await readdir(root)).toEqual([])
  })

  it('checks the current owner after writes and immediately before the rename', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')
    let current = true
    const checks: string[] = []

    await expect(
      atomicSavedWriteStream(target, byteChunks('new'), {
        ...bounds,
        beforeChunk: () => {
          checks.push('chunk')
          if (!current) throw new Error('STALE_OWNER')
        },
        beforeReplace: () => {
          checks.push('replace')
          current = false
        }
      })
    ).rejects.toThrow('STALE_OWNER')

    expect(checks.at(-1)).toBe('chunk')
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual([basename(target)])
  })

  it('cleans its owned temp without waiting for a producer that never returns', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    let checks = 0
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: Uint8Array.from(Buffer.from('x')) }),
          return: () => new Promise<IteratorResult<Uint8Array>>(() => {})
        }
      }
    }
    const write = atomicSavedWriteStream(target, source, {
      ...bounds,
      beforeChunk: () => {
        checks += 1
        if (checks === 2) throw new Error('STALE_OWNER')
      }
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    await expect(
      Promise.race([
        write,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('cleanup timed out')), 250)
        })
      ])
    ).rejects.toThrow('STALE_OWNER')
    clearTimeout(timeout)
    expect(await readdir(root)).toEqual([])
  })

  it('does not promote or remove a path swapped for a different temp inode', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    const temp = `${target}.${'ab'.repeat(12)}.tmp`
    await writeFile(target, 'old')

    await expect(
      atomicSavedWriteStream(target, byteChunks('new'), {
        ...bounds,
        beforeChunk: (() => {
          let checks = 0
          return () => {
            checks += 1
            if (checks !== 12) return
            unlinkSync(temp)
            writeFileSync(temp, 'foreign replacement')
          }
        })()
      })
    ).rejects.toMatchObject({ name: 'TEMP_OWNERSHIP' })

    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readFile(temp, 'utf8')).toBe('foreign replacement')
  })

  it.each(['append', 'same-size overwrite'] as const)('refuses same-inode %s before promotion', async (mutation) => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    const temp = `${target}.${'ab'.repeat(12)}.tmp`
    await writeFile(target, 'old')

    await expect(
      atomicSavedWriteStream(target, byteChunks('new'), {
        ...bounds,
        beforeChunk: (() => {
          let checks = 0
          return () => {
            checks += 1
            if (checks !== 12) return
            if (mutation === 'append') appendFileSync(temp, '!')
            else {
              const descriptor = openSync(temp, 'r+')
              try {
                writeSync(descriptor, Buffer.from('bad'), 0, 3, 0)
              } finally {
                closeSync(descriptor)
              }
            }
          }
        })()
      })
    ).rejects.toMatchObject({ name: 'TEMP_OWNERSHIP' })

    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readFile(temp, 'utf8')).toBe(mutation === 'append' ? 'new!' : 'bad')
  })

  it('rejects asynchronous owner checks before any replacement', async () => {
    const root = await directory()
    const target = join(root, 'meeting.md')
    await writeFile(target, 'old')
    let release!: () => void
    const delayed = new Promise<void>((resolve) => {
      release = resolve
    })

    await expect(
      atomicSavedWriteStream(target, byteChunks('new'), {
        ...bounds,
        beforeReplace: async () => delayed
      })
    ).rejects.toMatchObject({ name: 'ASYNC_ADMISSION' })
    release()
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual([basename(target)])
  })
})
