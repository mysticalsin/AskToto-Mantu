import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_ENTRY_LIMIT,
  createArchiveSink,
  isOwnedExtractionReceipt,
  type ArchiveOwnedDirectory,
  type ArchiveOwnedFile,
  type ArchiveOwnedWriter,
  type ArchivePhysicalIdentity,
  type OwnedExtractionReceipt
} from './archive'
import type { SpeechPackComponent } from './manifest'

const identity = (size = 0): ArchivePhysicalIdentity => ({
  dev: '1',
  ino: String(size + 1),
  mode: '33152',
  nlink: '1',
  uid: '501',
  gid: '20',
  rdev: '0',
  size: String(size),
  blocks: '1',
  mtimeNs: '3',
  ctimeNs: '4',
  birthtimeNs: '5',
  fileId: null
})

function ownedWriter(): { writer: ArchiveOwnedWriter; stored: string[] } {
  const stored: string[] = []
  const root: ArchiveOwnedDirectory = { relativePath: '', identity: identity() }
  const writer: ArchiveOwnedWriter = {
    async createRoot() {
      return root
    },
    async createDirectory(parent, name) {
      return { relativePath: parent.relativePath ? `${parent.relativePath}/${name}` : name, identity: identity() }
    },
    async createFile(parent, name) {
      const path = parent.relativePath ? `${parent.relativePath}/${name}` : name
      const chunks: Buffer[] = []
      const file: ArchiveOwnedFile = {
        async write(chunk) {
          chunks.push(Buffer.from(chunk))
        },
        async finish() {
          const bytes = Buffer.concat(chunks)
          const sha256 = createHash('sha256').update(bytes).digest('hex')
          stored.push(path)
          return { bytes: bytes.length, sha256, identity: identity(bytes.length) }
        },
        async abandon() {}
      }
      return file
    },
    async seal({ root: ownedRoot, nodes, pinnedFiles }) {
      return { root: ownedRoot, nodes, pinnedFiles }
    },
    async movePinnedFiles() {},
    async abandon() {}
  }
  return { writer, stored }
}

const component = (bytes: Buffer): SpeechPackComponent => ({
  id: 'asr.parakeet-tdt-0.6b-v3-int8',
  version: '1',
  files: [
    {
      path: 'model/pinned.bin',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  ],
  source: {
    kind: 'archive',
    archive: { url: 'https://example.test/archive', bytes: 1, sha256: 'a'.repeat(64) },
    entryPrefix: 'release/model',
    extractCapBytes: 1024
  }
})

const bytesOf = async function* (bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes
}

describe('owned archive sink', () => {
  it('drains permitted extras but seals only the writer-created pinned member', async () => {
    const pinned = Buffer.from('pinned model bytes')
    const { writer, stored } = ownedWriter()
    const sink = await createArchiveSink({
      writer,
      rootPath: 'private-test-root',
      component: component(pinned),
      signal: new AbortController().signal,
      assertCurrent: () => undefined
    })
    await sink.addFile('release/fixture.wav', bytesOf(Buffer.from('discard this extra')))
    await sink.addFile('release/model/model/pinned.bin', bytesOf(pinned))
    const receipt: OwnedExtractionReceipt = await sink.finish()

    expect(isOwnedExtractionReceipt(receipt)).toBe(true)
    expect(isOwnedExtractionReceipt({ ...receipt })).toBe(false)
    expect(stored).toEqual(['release/model/model/pinned.bin'])
    expect(receipt.pinnedFiles).toEqual(['release/model/model/pinned.bin'])
    expect(receipt.nodes.some((node) => node.relativePath === 'release/fixture.wav')).toBe(false)
  })

  it('waits for an unawaited addFile before sealing the created inventory', async () => {
    const pinned = Buffer.from('held writer bytes')
    const { writer } = ownedWriter()
    const sink = await createArchiveSink({
      writer,
      rootPath: 'private-test-root',
      component: component(pinned),
      signal: new AbortController().signal,
      assertCurrent: () => undefined
    })
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const delayed = async function* (): AsyncIterable<Uint8Array> {
      entered()
      await gate
      yield pinned
    }
    void sink.addFile('release/model/model/pinned.bin', delayed())
    await enteredPromise
    let finished = false
    const finish = sink.finish().then((receipt) => {
      finished = true
      return receipt
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    release()
    await expect(finish).resolves.toMatchObject({ pinnedFiles: ['release/model/model/pinned.bin'] })
  })

  it('rejects duplicate and unsafe names before sealing', async () => {
    const pinned = Buffer.from('one pinned file')
    const { writer, stored } = ownedWriter()
    const sink = await createArchiveSink({
      writer,
      rootPath: 'private-test-root',
      component: component(pinned),
      signal: new AbortController().signal,
      assertCurrent: () => undefined
    })
    await expect(sink.addFile('../escape', bytesOf(Buffer.alloc(0)))).rejects.toBeDefined()
    await sink.addFile('release/model/model/pinned.bin', bytesOf(pinned))
    await expect(sink.addFile('release/model/model/pinned.bin', bytesOf(pinned))).rejects.toBeDefined()
    await expect(sink.finish()).resolves.toBeDefined()
    expect(stored).toEqual(['release/model/model/pinned.bin'])
  })

  it('caps zero-byte extras independently of the extraction byte limit', async () => {
    const pinned = Buffer.from('one pinned file')
    const { writer } = ownedWriter()
    const sink = await createArchiveSink({
      writer,
      rootPath: 'private-test-root',
      component: component(pinned),
      signal: new AbortController().signal,
      assertCurrent: () => undefined
    })
    const empty = bytesOf(Buffer.alloc(0))
    for (let index = 0; index < ARCHIVE_ENTRY_LIMIT; index++) await sink.addFile(`e${index.toString(36)}`, empty)
    await expect(sink.addFile('entry-overflow', empty)).rejects.toBeDefined()
    await sink.abort()
  })
})
