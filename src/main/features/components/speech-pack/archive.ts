import { createHash } from 'node:crypto'
import { SpeechPackError } from './errors'
import type { SpeechPackComponent } from './manifest'

/** The only way an extractor supplies archive members. The writer is a main-owned storage capability. */
export interface ArchiveSink {
  /** Validates and counts every member, but stores only the exact manifest-pinned members. */
  addFile(name: string, data: AsyncIterable<Uint8Array>): Promise<void>
  /** Closes admission, settles every started write, and seals the exact writer-created inventory. */
  finish(): Promise<OwnedExtractionReceipt>
  /** Closes admission and settles every started write after an extractor error. */
  abort(): Promise<void>
}

export interface ArchiveOwnedDirectory {
  readonly relativePath: string
  readonly identity: ArchivePhysicalIdentity
}

export interface ArchiveOwnedFile {
  write(chunk: Uint8Array): Promise<void>
  finish(): Promise<{ bytes: number; sha256: string; identity: ArchivePhysicalIdentity }>
  abandon(): Promise<void>
}

export interface ArchivePhysicalIdentity {
  dev: string
  ino: string
  mode: string
  nlink: string
  uid: string
  gid: string
  rdev: string
  size: string
  blocks: string
  mtimeNs: string
  ctimeNs: string
  birthtimeNs: string
  fileId: string | null
}

export interface ArchiveCreatedNode {
  relativePath: string
  kind: 'directory' | 'file'
  identity: ArchivePhysicalIdentity
  bytes: number | null
  sha256: string | null
}

/** The owner constructs this only from its exclusive create receipts; a tree scan cannot issue one. */
export interface OwnedExtractionReceipt {
  readonly root: ArchiveOwnedDirectory
  readonly nodes: readonly ArchiveCreatedNode[]
  readonly pinnedFiles: readonly string[]
}

/** Untrusted, writer-returned claims that are checked before a sink receipt is issued. */
export interface ArchiveWriterInventory {
  readonly root: ArchiveOwnedDirectory
  readonly nodes: readonly ArchiveCreatedNode[]
  readonly pinnedFiles: readonly string[]
}

const issuedExtractionReceipts = new WeakSet<object>()

/** True only for inventories issued after the sink verified the writer's exclusive-create receipts. */
export function isOwnedExtractionReceipt(value: unknown): value is OwnedExtractionReceipt {
  return value !== null && typeof value === 'object' && issuedExtractionReceipts.has(value)
}

function issueExtractionReceipt(input: {
  root: ArchiveOwnedDirectory
  nodes: readonly ArchiveCreatedNode[]
  pinnedFiles: readonly string[]
}): OwnedExtractionReceipt {
  const root = Object.freeze({
    relativePath: input.root.relativePath,
    identity: Object.freeze({ ...input.root.identity })
  })
  const nodes = Object.freeze(
    input.nodes.map((node) =>
      Object.freeze({
        relativePath: node.relativePath,
        kind: node.kind,
        identity: Object.freeze({ ...node.identity }),
        bytes: node.bytes,
        sha256: node.sha256
      })
    )
  )
  const pinnedFiles = Object.freeze([...input.pinnedFiles])
  const receipt = Object.freeze({ root, nodes, pinnedFiles })
  issuedExtractionReceipts.add(receipt)
  return receipt
}

export interface ArchiveOwnedWriter {
  createRoot(path: string): Promise<ArchiveOwnedDirectory>
  createDirectory(parent: ArchiveOwnedDirectory, name: string): Promise<ArchiveOwnedDirectory>
  createFile(parent: ArchiveOwnedDirectory, name: string): Promise<ArchiveOwnedFile>
  seal(input: {
    root: ArchiveOwnedDirectory
    nodes: readonly ArchiveCreatedNode[]
    pinnedFiles: readonly string[]
  }): Promise<ArchiveWriterInventory>
  movePinnedFiles(input: {
    receipt: OwnedExtractionReceipt
    destinationPath: string
    files: readonly { path: string; bytes: number; sha256: string }[]
    assertCurrent: () => void
  }): Promise<void>
  abandon(root: ArchiveOwnedDirectory): Promise<void>
}

export type ExtractArchive = (archivePath: string, sink: ArchiveSink, signal: AbortSignal) => Promise<void>

const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu
export const ARCHIVE_ENTRY_LIMIT = 4096
export const ARCHIVE_NAME_BYTES_LIMIT = 16 * 1024

/** True when an archive entry name stays inside the extraction directory on both macOS and Windows. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\')) return false
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false
  return name
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.includes(':') &&
        !/[. ]$/.test(part) &&
        !WINDOWS_DEVICE_NAME.test(part)
    )
}

export async function createArchiveSink(input: {
  writer: ArchiveOwnedWriter
  rootPath: string
  component: SpeechPackComponent
  signal: AbortSignal
  assertCurrent: () => void
}): Promise<ArchiveSink> {
  const { writer, rootPath, component, signal, assertCurrent } = input
  if (component.source.kind !== 'archive') throw new SpeechPackError('tamper', 'archive sink has no archive pin')
  const root = await writer.createRoot(rootPath)
  const rootOwner = { dev: root.identity.dev, ino: root.identity.ino }
  const archive = component.source
  const prefix = archive.entryPrefix
  const pins = new Map(component.files.map((file) => [`${prefix}/${file.path}`, file]))
  const seen = new Set<string>()
  const directories = new Map<string, Promise<ArchiveOwnedDirectory>>([['', Promise.resolve(root)]])
  const nodes = new Map<string, ArchiveCreatedNode>()
  const pinnedFiles = new Set<string>()
  const pending = new Set<Promise<void>>()
  let closed = false
  let total = 0
  let nameBytes = 0

  const createParent = async (relativePath: string): Promise<ArchiveOwnedDirectory> => {
    const cached = directories.get(relativePath)
    if (cached) return cached
    const parentPath = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
    const name = relativePath.slice(parentPath ? parentPath.length + 1 : 0)
    const creation = (async () => {
      const parent = await createParent(parentPath)
      assertCurrent()
      const created = await writer.createDirectory(parent, name)
      assertCurrent()
      nodes.set(relativePath, {
        relativePath,
        kind: 'directory',
        identity: created.identity,
        bytes: null,
        sha256: null
      })
      return created
    })()
    directories.set(relativePath, creation)
    try {
      return await creation
    } catch (error) {
      directories.delete(relativePath)
      throw error
    }
  }

  const writeEntry = async (name: string, data: AsyncIterable<Uint8Array>): Promise<void> => {
    if (!isSafeEntryName(name)) throw new SpeechPackError('tamper', 'archive entry name is not allowed')
    if (seen.has(name)) throw new SpeechPackError('tamper', 'archive contains a duplicate entry')
    seen.add(name)
    nameBytes += Buffer.byteLength(name)
    if (seen.size > ARCHIVE_ENTRY_LIMIT || nameBytes > ARCHIVE_NAME_BYTES_LIMIT)
      throw new SpeechPackError('tamper', 'archive entry inventory exceeds its limit')
    const pin = pins.get(name)
    const hasher = pin ? createHash('sha256') : null
    let file: ArchiveOwnedFile | null = null
    let size = 0
    try {
      if (pin) {
        const parentPath = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
        const parent = await createParent(parentPath)
        assertCurrent()
        file = await writer.createFile(parent, name.slice(parentPath ? parentPath.length + 1 : 0))
        assertCurrent()
      }
      for await (const chunk of data) {
        if (signal.aborted) throw signal.reason
        assertCurrent()
        if (chunk.byteLength > archive.extractCapBytes - total)
          throw new SpeechPackError('tamper', 'archive expands beyond its size cap')
        total += chunk.byteLength
        size += chunk.byteLength
        if (pin) {
          if (size > pin.bytes) throw new SpeechPackError('tamper', 'pinned archive member is oversized')
          hasher?.update(chunk)
          await (file as ArchiveOwnedFile).write(chunk)
          assertCurrent()
        }
      }
      if (pin) {
        const result = await (file as ArchiveOwnedFile).finish()
        file = null
        assertCurrent()
        const sha256 = hasher?.digest('hex') as string
        if (size !== pin.bytes || sha256 !== pin.sha256 || result.bytes !== size || result.sha256 !== sha256)
          throw new SpeechPackError('tamper', 'pinned archive member does not match its pin')
        const relativePath = name
        nodes.set(relativePath, {
          relativePath,
          kind: 'file',
          identity: result.identity,
          bytes: result.bytes,
          sha256: result.sha256
        })
        pinnedFiles.add(name)
      }
    } catch (error) {
      await file?.abandon().catch(() => undefined)
      throw error
    }
  }

  return {
    addFile(name, data) {
      if (closed) return Promise.reject(new SpeechPackError('tamper', 'archive sink is already sealed'))
      const operation = writeEntry(name, data)
      operation.catch(() => undefined)
      pending.add(operation)
      void operation.finally(() => pending.delete(operation)).catch(() => undefined)
      return operation
    },
    async finish() {
      if (closed) throw new SpeechPackError('tamper', 'archive sink is already sealed')
      closed = true
      try {
        const outcomes = await Promise.allSettled([...pending])
        const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        if (failure) throw failure.reason
        if (pinnedFiles.size !== pins.size || [...pins.keys()].some((name) => !pinnedFiles.has(name)))
          throw new SpeechPackError('tamper', 'archive is missing a pinned member')
        assertCurrent()
        const inventory = [...nodes.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        const receipt = await writer.seal({ root, nodes: inventory, pinnedFiles: [...pinnedFiles].sort() })
        assertCurrent()
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !receipt.root ||
          typeof receipt.root !== 'object' ||
          !Array.isArray(receipt.nodes) ||
          !Array.isArray(receipt.pinnedFiles) ||
          receipt.root !== root ||
          receipt.root.identity.dev !== rootOwner.dev ||
          receipt.root.identity.ino !== rootOwner.ino ||
          receipt.nodes.length !== inventory.length ||
          receipt.pinnedFiles.length !== pins.size ||
          receipt.nodes.some((node, index) => {
            if (!node || typeof node !== 'object' || !node.identity || typeof node.identity !== 'object') return true
            const expected = inventory[index]
            const identityMatches =
              expected?.kind === 'directory'
                ? node.identity.dev === expected.identity.dev && node.identity.ino === expected.identity.ino
                : JSON.stringify(node.identity) === JSON.stringify(expected?.identity)
            return (
              !expected ||
              node.relativePath !== expected.relativePath ||
              node.kind !== expected.kind ||
              !identityMatches ||
              node.bytes !== expected.bytes ||
              node.sha256 !== expected.sha256
            )
          }) ||
          receipt.pinnedFiles.some((path, index) => path !== [...pinnedFiles].sort()[index])
        )
          throw new SpeechPackError('tamper', 'archive writer returned a mismatched ownership receipt')
        return issueExtractionReceipt({ root, nodes: receipt.nodes, pinnedFiles: receipt.pinnedFiles })
      } catch (error) {
        await writer.abandon(root)
        throw error
      }
    },
    async abort() {
      if (closed) return
      closed = true
      await Promise.allSettled([...pending])
      await writer.abandon(root)
    }
  }
}
