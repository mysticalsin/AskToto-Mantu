import { appendFile, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContentPresence, DatalessDetector } from './dataless'
import { createStorageGateway, invokeStorageSinkWhenActive, type StorageFs } from './gateway'
import { openRegularRead } from './gateway-stream'

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

  it('keeps source accounting when the sink transfers and detaches an owned chunk', async () => {
    const root = await localRoot()
    const source = 'detached chunks stay accounted'
    await writeFile(join(root, 'note.md'), source)
    const gateway = createStorageGateway({ root: () => root, detector: localDetector() })
    let delivered = 0

    const result = await gateway.stream(
      'note.md',
      async (chunk) => {
        delivered += chunk.byteLength
        structuredClone(chunk, { transfer: [chunk.buffer as ArrayBuffer] })
      },
      { maxBytes: Buffer.byteLength(source), maxChunkBytes: 5 }
    )

    expect(result).toMatchObject({ status: 'ok', bytesRead: Buffer.byteLength(source) })
    expect(delivered).toBe(Buffer.byteLength(source))
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

  it('does not deliver the physical max-plus-one byte when a source grows after admission', async () => {
    const root = await localRoot()
    const file = join(root, 'growing.md')
    await writeFile(file, '1234')
    const fs: StorageFs = {
      readdir,
      readFile,
      realpath,
      stat,
      lstat: (path) =>
        import('node:fs/promises').then(({ lstat }) =>
          lstat(path).then((value) => ({ isSymbolicLink: value.isSymbolicLink() }))
        ),
      openRead: async (path) => {
        const opened = await openRegularRead(path)
        await appendFile(path, '5')
        return opened
      }
    }
    const gateway = createStorageGateway({ root: () => root, detector: localDetector(), fs })
    const chunks: Uint8Array[] = []

    const result = await gateway.stream(
      'growing.md',
      async (chunk) => {
        chunks.push(chunk)
      },
      {
        maxBytes: 4,
        maxChunkBytes: 2
      }
    )

    expect(result).toMatchObject({ status: 'unavailable', code: 'SIZE_LIMIT' })
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe('1234')
  })

  it('refuses sink delivery when the signal is already aborted during read settlement', async () => {
    const root = await localRoot()
    await writeFile(join(root, 'note.md'), 'bounded')
    const controller = new AbortController()
    const fs: StorageFs = {
      readdir,
      readFile,
      realpath,
      stat,
      lstat: (path) =>
        import('node:fs/promises').then(({ lstat }) =>
          lstat(path).then((value) => ({ isSymbolicLink: value.isSymbolicLink() }))
        ),
      openRead: async (path) => {
        const opened = await openRegularRead(path)
        let aborted = false
        return {
          stats: opened.stats,
          handle: {
            read: async (buffer, offset, length, position) => {
              const result = await opened.handle.read(buffer, offset, length, position)
              if (!aborted && result.bytesRead > 0) {
                aborted = true
                controller.abort()
              }
              return result
            },
            stat: () => opened.handle.stat(),
            close: () => opened.handle.close()
          }
        }
      }
    }
    const gateway = createStorageGateway({ root: () => root, detector: localDetector(), fs })
    let sinkCalls = 0

    const result = await gateway.stream(
      'note.md',
      async () => {
        sinkCalls += 1
      },
      { maxBytes: 16, maxChunkBytes: 4, signal: controller.signal }
    )

    expect(result).toEqual({ status: 'aborted' })
    expect(sinkCalls).toBe(0)
  })

  it('checks abort after read settlement but before the queued sink thunk runs', async () => {
    const controller = new AbortController()
    const read = Promise.resolve(new Uint8Array([1, 2, 3]))
    const chunk = await read
    let sinkCalls = 0
    const scheduled = invokeStorageSinkWhenActive(
      () => {
        sinkCalls += 1
      },
      chunk,
      controller.signal
    )
    controller.abort()
    await scheduled
    expect(sinkCalls).toBe(0)
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
