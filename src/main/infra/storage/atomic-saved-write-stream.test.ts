import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicSavedWriteStream } from './atomic-saved-write'

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
    await expect(
      atomicSavedWriteStream(target, byteChunks('12345678', '12345678', 'x'), bounds)
    ).rejects.toMatchObject({ name: 'RESOURCE_LIMIT' })
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
})
