import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContentPresence, DatalessDetector } from './dataless'
import { createStorageGateway } from './gateway'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function localRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metis-storage-stream-'))
  roots.push(root)
  return root
}

function localDetector(): DatalessDetector {
  return { classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, 'local'])) }
}

describe('bounded storage streams', () => {
  it('streams exact bytes in bounded owned chunks and returns the pinned version', async () => {
    const root = await localRoot()
    const source = 'alpha\r\nbeta\n'
    await writeFile(join(root, 'note.md'), source)
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    const chunks: Uint8Array[] = []

    const result = await gateway.stream(
      'note.md',
      async (chunk) => {
        chunks.push(chunk)
      },
      { maxBytes: Buffer.byteLength(source), maxChunkBytes: 4 }
    )

    expect(result).toMatchObject({ status: 'ok', bytesRead: Buffer.byteLength(source) })
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe(source)
    expect(chunks.every((chunk) => chunk.byteLength <= 4 && chunk.byteOffset === 0)).toBe(true)
    if (result.status === 'ok') expect(result.version.size).toBe(Buffer.byteLength(source))
  })

  it('does not emit content for a file above the admitted byte ceiling', async () => {
    const root = await localRoot()
    await writeFile(join(root, 'large.md'), '12345')
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    const chunks: Uint8Array[] = []

    const result = await gateway.stream(
      'large.md',
      async (chunk) => {
        chunks.push(chunk)
      },
      {
        maxBytes: 4,
        maxChunkBytes: 2
      }
    )

    expect(result).toMatchObject({ status: 'unavailable', code: 'SIZE_LIMIT' })
    expect(chunks).toEqual([])
  })

  it('keeps the admitted byte and chunk limits when the caller mutates its options', async () => {
    const root = await localRoot()
    await writeFile(join(root, 'note.md'), 'abcdefgh')
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    const options = { maxBytes: 8, maxChunkBytes: 2 }
    const chunks: Uint8Array[] = []

    const result = await gateway.stream(
      'note.md',
      async (chunk) => {
        chunks.push(chunk)
        options.maxBytes = 1
        options.maxChunkBytes = 1
      },
      options
    )

    expect(result).toMatchObject({ status: 'ok', bytesRead: 8, chunksRead: 4 })
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([2, 2, 2, 2])
  })

  it('rejects symlink inputs and never sends their target bytes to the sink', async () => {
    const root = await localRoot()
    const target = join(root, 'target.md')
    await writeFile(target, 'private target')
    await symlink(target, join(root, 'linked.md'))
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    const chunks: Uint8Array[] = []

    const result = await gateway.stream(
      'linked.md',
      async (chunk) => {
        chunks.push(chunk)
      },
      {
        maxBytes: 100,
        maxChunkBytes: 10
      }
    )

    expect(result).toMatchObject({ status: 'unavailable', code: 'SYMLINK' })
    expect(chunks).toEqual([])
    expect(await readFile(target, 'utf8')).toBe('private target')
  })

  it('stops between chunks when the caller aborts', async () => {
    const root = await localRoot()
    await writeFile(join(root, 'note.md'), 'abcdefgh')
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    const controller = new AbortController()
    let count = 0

    const result = await gateway.stream(
      'note.md',
      async () => {
        count += 1
        controller.abort()
      },
      { maxBytes: 8, maxChunkBytes: 2, signal: controller.signal }
    )

    expect(result).toEqual({ status: 'aborted' })
    expect(count).toBe(1)
  })
})
